import {PlayerModes} from '../enums/PlayerModes.mjs';
import {Coloris} from '../modules/coloris.mjs';
import {Localize} from '../modules/Localize.mjs';
import {streamSaver} from '../modules/StreamSaver.mjs';
import {ClickActions} from '../options/defaults/ClickActions.mjs';
import {MiniplayerPositions} from '../options/defaults/MiniplayerPositions.mjs';
import {VisChangeActions} from '../options/defaults/VisChangeActions.mjs';
import {SubtitleTrack} from '../SubtitleTrack.mjs';
import {EnvUtils} from '../utils/EnvUtils.mjs';
import {FastStreamArchiveUtils} from '../utils/FastStreamArchiveUtils.mjs';
import {RequestUtils} from '../utils/RequestUtils.mjs';
import {StringUtils} from '../utils/StringUtils.mjs';
import {URLUtils} from '../utils/URLUtils.mjs';
import {Utils} from '../utils/Utils.mjs';
import {WebUtils} from '../utils/WebUtils.mjs';
import {VideoSource} from '../VideoSource.mjs';
import {DOMElements} from './DOMElements.mjs';
import {LanguageChanger} from './menus/LanguageChanger.mjs';
import {PlaybackRateChanger} from './menus/PlaybackRateChanger.mjs';
import {VideoQualityChanger} from './menus/VideoQualityChanger.mjs';
import {OptionsWindow} from './OptionsWindow.mjs';
import {ProgressBar} from './ProgressBar.mjs';
import {StatusManager} from './StatusManager.mjs';
import {SubtitlesManager} from './subtitles/SubtitlesManager.mjs';

export class InterfaceController {
  constructor(client) {
    this.client = client;
    this.persistent = client.persistent;
    this.hidden = false;
    this.lastTime = 0;
    this.lastSpeed = 0;
    this.mouseOverControls = false;
    this.mouseActivityCooldown = 0;

    this.failed = false;

    this.subtitlesManager = new SubtitlesManager(this.client);

    this.playbackRateChanger = new PlaybackRateChanger();
    this.playbackRateChanger.setupUI();
    this.playbackRateChanger.on('rateChanged', (rate) => {
      this.client.playbackRate = rate;
    });

    this.videoQualityChanger = new VideoQualityChanger();
    this.videoQualityChanger.setupUI();
    this.videoQualityChanger.on('qualityChanged', (level) => {
      this.client.currentLevel = level;
    });

    this.languageChanger = new LanguageChanger();
    this.languageChanger.setupUI();
    this.languageChanger.on('languageChanged', (track) => {
      this.client.setLanguageTrack(track);
    });

    this.playbackRateChanger.on('open', this.closeAllMenus.bind(this));
    this.videoQualityChanger.on('open', this.closeAllMenus.bind(this));
    this.languageChanger.on('open', this.closeAllMenus.bind(this));
    this.subtitlesManager.on('open', this.closeAllMenus.bind(this));

    this.progressBar = new ProgressBar(this.client);
    this.progressBar.on('enteredSkipSegment', (segment)=>{
      this.showControlBar();
      this.queueControlsHide(5000);
    });
    this.progressBar.setupUI();

    this.statusManager = new StatusManager();
    this.optionsWindow = new OptionsWindow();

    this.setupDOM();
  }

  closeAllMenus() {
    this.playbackRateChanger.closeUI();
    this.videoQualityChanger.closeUI();
    this.languageChanger.closeUI();
    this.subtitlesManager.closeUI();
  }

  setStatusMessage(key, message, type, expiry) {
    this.statusManager.setStatusMessage(key, message, type, expiry);
  }

  tick() {
    if (this.client.player) {
      this.updateFragmentsLoaded();
      this.checkBuffering();
    }

    this.statusManager.updateStatusMessage();
  }

  checkBuffering() {
    const currentVideo = this.client.currentVideo;
    if (this.persistent.playing) {
      const time = this.client.currentTime;
      if (time === this.lastTime) {
        this.setBuffering(true);
      } else {
        this.setBuffering(false);
      }
      this.lastTime = time;
    } else if (currentVideo) {
      if (currentVideo.readyState === 0) {
        this.setBuffering(true);
      } else if (currentVideo.readyState > 1) {
        this.setBuffering(false);
      }
    }
  }

  reset() {
    DOMElements.videoContainer.replaceChildren();

    this.progressBar.reset();
    this.failed = false;
    this.setStatusMessage('error', null, 'error');
    this.setStatusMessage('chapter', null, 'error');
    this.reuseDownloadURL = false;
    if (this.downloadURL) {
      URL.revokeObjectURL(this.downloadURL);
    }
    this.downloadURL = null;
    this.stopProgressLoop();
    this.persistent.playing = false;
    this.updatePlayPauseButton();
    DOMElements.playPauseButtonBigCircle.style.display = '';
    DOMElements.playerContainer.classList.add('controls_visible');
    this.updateToolVisibility();
  }

  failedToLoad(reason) {
    this.failed = true;
    this.setStatusMessage('error', reason, 'error');
    this.setBuffering(false);
  }

  setBuffering(isBuffering) {
    if (this.failed) {
      isBuffering = false;
    }

    if (this.persistent.buffering === isBuffering) {
      return;
    }

    this.persistent.buffering = isBuffering;

    if (isBuffering) {
      DOMElements.bufferingSpinner.style.display = '';
    } else {
      DOMElements.bufferingSpinner.style.display = 'none';
    }
  }

  dressVideo(video) {
    video.setAttribute('playsinline', 'playsinline');
    video.disableRemotePlayback = true;
  }

  addVideo(video) {
    this.dressVideo(video);
    DOMElements.videoContainer.appendChild(video);
  }

  addPreviewVideo(video) {
    this.dressVideo(video);
    DOMElements.seekPreviewVideo.style.display = '';
    DOMElements.seekPreviewVideo.appendChild(video);
  }

  updateMarkers() {
    this.progressBar.updateMarkers();
  }

  updateFragmentsLoaded() {
    this.progressBar.updateFragmentsLoaded();
    this.updateDownloadStatus();
  }

  updateDownloadStatus() {
    const {loaded, total, failed} = this.progressBar.getFragmentCounts();
    if (total === 0) {
      this.setStatusMessage('download', null);
      return;
    }

    const percentDone = total === 0 ? 0 :
        Math.floor((loaded / total) * 1000) / 10;

    const newSpeed = this.client.downloadManager.getSpeed();
    if (newSpeed > 0 && this.lastSpeed > 0) {
      this.lastSpeed = (newSpeed * 0.05 + this.lastSpeed * 0.95) || 0;
    } else {
      this.lastSpeed = newSpeed;
    }

    let speed = this.lastSpeed; // bytes per second
    speed = Math.round(speed / 1000 / 1000 * 10) / 10; // MB per second

    if (total === 0 || loaded < total) {
      this.shownDownloadComplete = false;
      this.setStatusMessage('download', `${this.client.downloadManager.downloaders.length}C ↓${speed}MB/s ${percentDone}%`, 'success');
    } else if (!this.shownDownloadComplete) {
      this.shownDownloadComplete = true;
      this.setStatusMessage('download', Localize.getMessage('player_fragment_allbuffered'), 'success', 2000);
    }

    if (failed > 0) {
      DOMElements.resetFailed.style.display = '';
      DOMElements.resetFailed.textContent = Localize.getMessage(failed === 1 ? 'player_fragment_failed_singular' : 'player_fragment_failed_plural', [failed]);
    } else {
      DOMElements.resetFailed.style.display = 'none';
    }
  }

  updateSkipSegments() {
    this.progressBar.updateSkipSegments();
  }

  setupDOM() {
    DOMElements.volumeContainer.addEventListener('mousedown', this.onVolumeBarMouseDown.bind(this));
    DOMElements.muteBtn.addEventListener('click', this.muteToggle.bind(this));
    DOMElements.volumeBlock.tabIndex = 0;
    DOMElements.volumeBlock.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        this.muteToggle();
        e.stopPropagation();
      } else if (e.key === 'ArrowLeft') {
        this.client.volume = Math.max(0, this.client.volume - 0.1);
        e.stopPropagation();
      } else if (e.key === 'ArrowRight') {
        this.client.volume = Math.min(3, this.client.volume + 0.1);
        e.stopPropagation();
      }
    });

    DOMElements.volumeBlock.addEventListener('wheel', (e) => {
      this.client.volume = Math.max(0, Math.min(3, this.client.volume + e.deltaY * 0.01));
      e.preventDefault();
      e.stopPropagation();
    });

    DOMElements.playPauseButton.addEventListener('click', this.playPauseToggle.bind(this));
    WebUtils.setupTabIndex(DOMElements.playPauseButton);

    DOMElements.playPauseButtonBigCircle.addEventListener('click', (e) => {
      this.hideControlBarOnAction();
      this.playPauseToggle();
      e.stopPropagation();
    });

    DOMElements.fullscreen.addEventListener('click', this.fullscreenToggle.bind(this));
    WebUtils.setupTabIndex(DOMElements.fullscreen);

    document.addEventListener('fullscreenchange', this.updateFullScreenButton.bind(this));

    DOMElements.playerContainer.addEventListener('mousemove', this.onPlayerMouseMove.bind(this));
    DOMElements.controlsContainer.addEventListener('mouseenter', this.onControlsMouseEnter.bind(this));
    DOMElements.controlsContainer.addEventListener('mouseleave', this.onControlsMouseLeave.bind(this));
    DOMElements.controlsContainer.addEventListener('focusin', ()=>{
      this.focusingControls = true;
      this.showControlBar();
    });
    DOMElements.controlsContainer.addEventListener('focusout', ()=>{
      this.focusingControls = false;
      this.queueControlsHide();
    });
    let clickCount = 0;
    let clickTimeout = null;
    DOMElements.videoContainer.addEventListener('click', (e) => {
      if (this.isBigPlayButtonVisible()) {
        this.playPauseToggle();
        return;
      }

      if (clickTimeout !== null) {
        clickCount++;
      } else {
        clickCount = 1;
      }
      clearTimeout(clickTimeout);
      clickTimeout = setTimeout(() => {
        clickTimeout = null;

        let clickAction;
        if (clickCount === 1) {
          clickAction = this.client.options.singleClickAction;
        } else if (clickCount === 2) {
          clickAction = this.client.options.doubleClickAction;
        } else if (clickCount === 3) {
          clickAction = this.client.options.tripleClickAction;
        } else {
          return;
        }

        switch (clickAction) {
          case ClickActions.FULLSCREEN:
            this.fullscreenToggle();
            break;
          case ClickActions.PIP:
            this.pipToggle();
            break;
          case ClickActions.PLAY_PAUSE:
            this.playPauseToggle();
            break;
          case ClickActions.HIDE_CONTROLS:
            this.focusingControls = false;
            this.mouseOverControls = false;
            this.hideControlBar();
            break;
          case ClickActions.HIDE_PLAYER:
            this.toggleHide();
            break;
        }
      }, clickCount < 3 ? 300 : 0);
    });
    DOMElements.hideButton.addEventListener('click', () => {
      DOMElements.hideButton.blur();
      this.focusingControls = false;
      this.hideControlBar();
    });

    WebUtils.setupTabIndex(DOMElements.hideButton);

    DOMElements.resetFailed.addEventListener('click', (e) => {
      this.client.resetFailed();
      e.stopPropagation();
    });
    WebUtils.setupTabIndex(DOMElements.resetFailed);

    DOMElements.skipButton.addEventListener('click', this.skipSegment.bind(this));

    DOMElements.download.addEventListener('click', this.saveVideo.bind(this));
    WebUtils.setupTabIndex(DOMElements.download);

    DOMElements.screenshot.addEventListener('click', this.saveScreenshot.bind(this));
    WebUtils.setupTabIndex(DOMElements.screenshot);

    DOMElements.pip.addEventListener('click', this.pipToggle.bind(this));
    WebUtils.setupTabIndex(DOMElements.pip);

    DOMElements.playerContainer.addEventListener('drop', this.onFileDrop.bind(this), false);

    DOMElements.playerContainer.addEventListener('dragenter', (e) => {
      e.stopPropagation();
      e.preventDefault();
    }, false);
    DOMElements.playerContainer.addEventListener('dragover', (e) => {
      e.stopPropagation();
      e.preventDefault();
    }, false);

    DOMElements.settingsButton.addEventListener('click', (e) => {
      if (e.shiftKey) {
        chrome.runtime.openOptionsPage();
      } else {
        this.optionsWindow.toggleUI();
      }
      e.stopPropagation();
    });
    WebUtils.setupTabIndex(DOMElements.settingsButton);

    const welcomeText = Localize.getMessage('player_welcometext', [this.client.version]);
    this.setStatusMessage('welcome', welcomeText, 'info', 3000);

    DOMElements.controlsContainer.addEventListener('click', (e) => {
      e.stopPropagation();
    });

    document.addEventListener('visibilitychange', ()=>{
      if (!document.hidden) {
        this.handleVisibilityChange(true);
      } else {
        this.handleVisibilityChange(false);
      }
    });

    const o = new IntersectionObserver(([entry]) => {
      if (entry.intersectionRatio > 0.25 && !document.hidden) {
        this.handleVisibilityChange(true);
      } else {
        this.handleVisibilityChange(false);
      }
    }, {
      threshold: [0, 0.25, 0.5],
    });

    o.observe(document.body);

    // eslint-disable-next-line new-cap
    Coloris({
      theme: 'pill',
      themeMode: 'dark',
      formatToggle: true,
      swatches: [
        'rgb(255,255,255)',
        'rgba(10,10,10,0.3)',
        '#067bc2',
        '#ecc30b',
        '#f37748',
        '#d56062',
      ],
      alpha: true,
    });

    this.updateToolVisibility();
  }

  async handleVisibilityChange(isVisible) {
    const action = this.client.options.visChangeAction;

    if (isVisible === this.lastPageVisibility || this.miniPlayerActive) {
      return;
    }
    switch (action) {
      case VisChangeActions.NOTHING:
        break;
      case VisChangeActions.PLAY_PAUSE:
        if (!isVisible) {
          this.shouldPlay = this.client.persistent.playing;
          await this.client.player?.pause();
        } else {
          if (this.shouldPlay) {
            await this.client.player?.play();
          }
        }
        break;
      case VisChangeActions.PIP:
        if (!isVisible) {
          await this.enterPip();
        } else {
          await this.exitPip();
        }
        break;
      case VisChangeActions.MINI_PLAYER:
        this.requestMiniplayer(!isVisible);
        break;
    }

    this.lastPageVisibility = isVisible;
  }

  requestMiniplayer(force) {
    if (EnvUtils.isExtension()) {
      this.miniPlayerActive = true;

      const styles = {};
      switch (this.client.options.miniPos) {
        case MiniplayerPositions.TOP_LEFT:
          styles.top = '0px';
          styles.left = '0px';
          break;
        case MiniplayerPositions.TOP_RIGHT:
          styles.top = '0px';
          styles.right = '0px';
          break;
        case MiniplayerPositions.BOTTOM_LEFT:
          styles.bottom = '0px';
          styles.left = '0px';
          break;
        case MiniplayerPositions.BOTTOM_RIGHT:
          styles.bottom = '0px';
          styles.right = '0px';
          break;
      }

      chrome.runtime.sendMessage({
        type: 'request_miniplayer',
        size: this.client.options.miniSize,
        force,
        styles,
        autoExit: true,
      }, (response) => {
        if (response !== 'enter') {
          this.miniPlayerActive = false;
        }
      });
    }
  }

  setMiniplayerStatus(isMini) {
    if (isMini) {
      this.miniPlayerActive = true;
      DOMElements.playerContainer.classList.add('miniplayer');
    } else {
      this.miniPlayerActive = false;
      DOMElements.playerContainer.classList.remove('miniplayer');
    }
  }

  updateToolVisibility() {
    DOMElements.pip.style.display = (this.client.player && document.pictureInPictureEnabled) ? 'inline-block' : 'none';
    DOMElements.download.style.display = (this.client.player && !this.client.player.canSave().cantSave) ? 'inline-block' : 'none';
    DOMElements.screenshot.style.display = this.client.player ? 'inline-block' : 'none';
    DOMElements.playinfo.style.display = this.client.player ? 'none' : '';
  }

  toggleHide() {
    if (this.hidden) {
      DOMElements.playerContainer.classList.remove('player-hidden');
      this.hidden = false;
      if (this.shouldPlay) {
        this.client.player?.play();
      }
    } else {
      DOMElements.playerContainer.classList.add('player-hidden');

      this.hidden = true;
      this.shouldPlay = this.client.persistent.playing;
      this.client.player?.pause();
    }
  }

  async documentPipToggle() {
    if (window.documentPictureInPicture.window) {
      window.documentPictureInPicture.window.close();
      return;
    }

    const pipWindow = await documentPictureInPicture.requestWindow({
      width: DOMElements.playerContainer.clientWidth,
      height: DOMElements.playerContainer.clientHeight,
    });

    pipWindow.document.body.appendChild(DOMElements.playerContainer);

    // Copy style sheets over from the initial document
    // so that the player looks the same.
    [...document.styleSheets].forEach((styleSheet) => {
      try {
        const cssRules = [...styleSheet.cssRules]
            .map((rule) => rule.cssText)
            .join('');
        const style = document.createElement('style');

        style.textContent = cssRules;
        pipWindow.document.head.appendChild(style);
      } catch (e) {
        const link = document.createElement('link');

        link.rel = 'stylesheet';
        link.type = styleSheet.type;
        link.media = styleSheet.media;
        link.href = styleSheet.href;
        pipWindow.document.head.appendChild(link);
      }
    });

    pipWindow.addEventListener('pagehide', (event) => {
      document.body.appendChild(DOMElements.playerContainer);
    });
  }

  pipToggle() {
    if (document.pictureInPictureElement) {
      return this.exitPip();
    } else {
      return this.enterPip();
    }
  }

  exitPip() {
    if (document.pictureInPictureElement) {
      return document.exitPictureInPicture();
    }
    return Promise.resolve();
  }

  enterPip() {
    if (!document.pictureInPictureElement && this.client.player) {
      return this.client.player.getVideo().requestPictureInPicture();
    }
    return Promise.resolve();
  }

  async onFileDrop(e) {
    e.stopPropagation();
    e.preventDefault();

    const dt = e.dataTransfer;
    const files = dt.files;
    const captions = [];
    const audioFormats = [
      'mp3',
      'wav',
      'm4a',
      'm4r',
    ];

    const subtitleFormats = [
      'vtt',
      'srt',
      'xml',
    ];

    let newSource = null;
    let newEntries = null;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const ext = URLUtils.get_url_extension(file.name);

      if (ext === 'json') {
        const fsprofile = await file.text();
        const data = JSON.parse(fsprofile);

        if (data?.type === 'audioProfile') {
          this.client.audioConfigManager.loadProfileFile(data);
        }
      } else if (subtitleFormats.includes(ext)) {
        captions.push({
          url: window.URL.createObjectURL(file),
          name: file.name.substring(0, file.name.length - 4),
        });
      } else if (audioFormats.includes(ext)) {
        newSource = new VideoSource(window.URL.createObjectURL(file), {}, PlayerModes.DIRECT);
        newSource.identifier = file.name + 'size' + file.size;
      } else if (URLUtils.getModeFromExtension(ext)) {
        let mode = URLUtils.getModeFromExtension(ext);
        if (mode === PlayerModes.ACCELERATED_MP4) {
          mode = PlayerModes.DIRECT;
        }
        newSource = new VideoSource(window.URL.createObjectURL(file), {}, mode);
        newSource.identifier = file.name + 'size' + file.size;
      } else if (ext === 'fsa') {
        const buffer = await RequestUtils.httpGetLarge(window.URL.createObjectURL(file));
        try {
          const {source, entries, currentLevel, currentAudioLevel} = await FastStreamArchiveUtils.parseFSA(buffer, (progress)=>{
            this.setStatusMessage('save-video', Localize.getMessage('player_archive_loading', [Math.floor(progress * 100)]), 'info');
          }, this.client.downloadManager);

          newEntries = entries;

          newSource = new VideoSource(source.url, null, source.mode);
          newSource.identifier = source.identifier;
          newSource.headers = source.headers;
          newSource.defaultLevelInfo = {
            level: currentLevel,
            audioLevel: currentAudioLevel,
          };

          this.setStatusMessage('save-video', Localize.getMessage('player_archive_loaded'), 'info', 2000);
        } catch (e) {
          console.error(e);
          this.setStatusMessage('save-video', Localize.getMessage('player_archive_fail'), 'error', 2000);
        }
      }
    }

    if (newSource) {
      if (newEntries) {
        this.client.downloadManager.resetOverride(true);
        this.client.downloadManager.setEntries(newEntries);
      }

      try {
        await this.client.addSource(newSource, true);
      } catch (e) {
        console.error(e);
      }

      if (newEntries) {
        this.client.downloadManager.resetOverride(false);
      }
    }

    (await Promise.all(captions.map(async (file) => {
      const track = new SubtitleTrack(file.name);
      await track.loadURL(file.url);
      return track;
    }))).forEach((track) => {
      const returnedTrack = this.client.loadSubtitleTrack(track);
      this.subtitlesManager.activateTrack(returnedTrack);
    });

    this.client.play();
  }
  destroy() {
    if (this.downloadURL) {
      URL.revokeObjectURL(this.downloadURL);
      this.downloadURL = null;
    }
  }

  progressLoop() {
    if (!this.shouldRunProgressLoop) {
      this.isRunningProgressLoop = false;
      return;
    }
    window.requestAnimationFrame(this.progressLoop.bind(this));
    if (!this.progressBar.isSeeking) {
      this.client.updateTime(this.client.currentTime);
    }
  }

  durationChanged() {
    const duration = this.client.duration;
    if (duration < 5 * 60 || this.subtitlesManager.subtitleSyncer.started) {
      this.runProgressLoop();
    } else {
      this.stopProgressLoop();
    }
    this.timeUpdated();
  }

  runProgressLoop() {
    if (!this.isRunningProgressLoop) {
      this.isRunningProgressLoop = true;
      this.shouldRunProgressLoop = true;
      this.progressLoop();
    }
  }

  stopProgressLoop() {
    this.shouldRunProgressLoop = false;
  }

  async saveScreenshot() {
    if (!this.client.player) {
      alert(Localize.getMessage('player_nosource_alert'));
      return;
    }

    const suggestedName = (this.client.mediaName || 'video').replaceAll(' ', '_') + '@' + StringUtils.formatTime(this.client.currentTime);
    const name = EnvUtils.isIncognito() ? suggestedName : prompt(Localize.getMessage('player_filename_prompt'), suggestedName);

    if (!name) {
      return;
    }

    this.setStatusMessage('save-screenshot', Localize.getMessage('player_screenshot_saving'), 'info');
    try {
      const video = this.client.player.getVideo();
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      // const blob = await new Promise((resolve) => {
      //   canvas.toBlob(resolve, 'image/png');
      // });

      const url = canvas.toDataURL('image/png'); // For some reason this is faster than async
      // const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.setAttribute('href', url);
      link.setAttribute('download', name + '.png');
      link.setAttribute('target', '_blank');
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      this.setStatusMessage('save-screenshot', Localize.getMessage('player_screenshot_saved'), 'info', 1000);
    } catch (e) {
      console.error(e);
      this.setStatusMessage('save-screenshot', Localize.getMessage('player_screenshot_fail'), 'error', 2000);
    }
  }

  async saveVideo(e) {
    if (!this.client.player) {
      alert(Localize.getMessage('player_nosource_alert'));
      return;
    }

    if (this.makingDownload) {
      alert(Localize.getMessage('player_savevideo_inprogress_alert'));
      return;
    }

    const doPartial = e.altKey;
    const doDump = e.shiftKey;
    const player = this.client.player;

    const {canSave, isComplete, canStream} = player.canSave();

    if (!canSave && !doDump) {
      alert(Localize.getMessage('player_savevideo_unsupported'));
      return;
    }

    if (doPartial && !isComplete) {
      const res = confirm(Localize.getMessage('player_savevideo_partial_confirm'));
      if (!res) {
        return;
      }
    }

    if (!doPartial && !isComplete && EnvUtils.isIncognito()) {
      const res = confirm(Localize.getMessage('player_savevideo_incognito_confirm'));
      if (!res) {
        return;
      }
    }

    const suggestedName = (this.client.mediaName || 'video').replaceAll(' ', '_');
    const name = EnvUtils.isIncognito() ? suggestedName : prompt(Localize.getMessage('player_filename_prompt'), suggestedName);

    if (!name) {
      return;
    }

    if (doDump) {
      this.dumpBuffer(name);
      return;
    }

    let url;
    let filestream;
    if (canStream) {
      filestream = streamSaver.createWriteStream(name + '.mp4');
    }

    if (this.reuseDownloadURL && this.downloadURL && isComplete) {
      url = this.downloadURL;
    } else {
      this.reuseDownloadURL = isComplete;
      let result;
      this.makingDownload = true;
      this.setStatusMessage('save-video', Localize.getMessage('player_savevideo_start'), 'info');
      try {
        const start = performance.now();
        result = await player.saveVideo({
          onProgress: (progress) => {
            this.setStatusMessage('save-video', Localize.getMessage('player_savevideo_progress', [Math.floor(progress * 100)]), 'info');
          },
          filestream,
          partialSave: doPartial,
        });
        const end = performance.now();
        console.log('Save took ' + (end - start) / 1000 + 's');
      } catch (e) {
        console.error(e);
        this.setStatusMessage('save-video', Localize.getMessage('player_savevideo_fail'), 'error', 2000);
        this.makingDownload = false;

        if (confirm(Localize.getMessage('player_savevideo_failed_ask_archive'))) {
          this.dumpBuffer(name);
        }
        return;
      }
      this.setStatusMessage('save-video', Localize.getMessage('player_savevideo_complete'), 'info', 2000);
      this.makingDownload = false;
      if (this.downloadURL) {
        URL.revokeObjectURL(this.downloadURL);
        this.downloadURL = null;
      }

      if (!canStream) {
        url = URL.createObjectURL(result.blob);
      }

      setTimeout(() => {
        if (this.downloadURL !== url) return;

        if (this.downloadURL) {
          URL.revokeObjectURL(this.downloadURL);
          this.downloadURL = null;
          this.reuseDownloadURL = false;
        }
      }, 10000);
    }

    if (!canStream) {
      this.downloadURL = url;

      const link = document.createElement('a');
      link.setAttribute('href', url);
      link.setAttribute('download', name + '.mp4');
      link.setAttribute('target', '_blank');
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
  }

  async dumpBuffer(name) {
    const entries = this.client.downloadManager.getCompletedEntries();
    const filestream = streamSaver.createWriteStream(name + '.fsa');
    try {
      await FastStreamArchiveUtils.writeFSAToStream(filestream, this.client.player, entries, (progress)=>{
        this.setStatusMessage('save-video', Localize.getMessage('player_archiver_progress', [Math.floor(progress * 100)]), 'info');
      });

      this.setStatusMessage('save-video', Localize.getMessage('player_archiver_saved'), 'info', 2000);
    } catch (e) {
      console.error(e);
      this.setStatusMessage('save-video', 'Unreachable Error', 'error', 2000);
    }
  }

  skipSegment() {
    this.progressBar.skipSegment();
    this.hideControlBarOnAction();
  }

  onControlsMouseEnter() {
    this.showControlBar();
    this.mouseOverControls = true;
  }
  onControlsMouseLeave() {
    this.mouseOverControls = false;
    if (document.activeElement && DOMElements.controlsContainer.contains(document.activeElement)) document.activeElement.blur();
    this.queueControlsHide();
  }
  onPlayerMouseMove() {
    if (Date.now() < this.mouseActivityCooldown) {
      return;
    }
    this.showControlBar();
    this.queueControlsHide();
  }

  queueControlsHide(time) {
    clearTimeout(this.hideControlBarTimeout);
    this.hideControlBarTimeout = setTimeout(() => {
      if (!this.focusingControls && !this.mouseOverControls && !this.isBigPlayButtonVisible() && this.persistent.playing) {
        this.hideControlBar();
      }
    }, time || 2000);
  }

  hideControlBarOnAction(cooldown) {
    if (!this.mouseOverControls && !this.focusingControls) {
      this.mouseActivityCooldown = Date.now() + (cooldown || 500);
      if (!this.isBigPlayButtonVisible()) {
        this.hideControlBar();
      }
    }
  }

  hideBigPlayButton() {
    DOMElements.playPauseButtonBigCircle.style.display = 'none';
  }

  isBigPlayButtonVisible() {
    return DOMElements.playPauseButtonBigCircle.style.display !== 'none';
  }

  hideControlBar() {
    clearTimeout(this.hideControlBarTimeout);
    DOMElements.playerContainer.classList.remove('controls_visible');
    DOMElements.controlsContainer.classList.remove('fade_in');
    DOMElements.controlsContainer.classList.add('fade_out');
    DOMElements.progressContainer.classList.remove('freeze');
  }

  showControlBar() {
    DOMElements.playerContainer.classList.add('controls_visible');
    DOMElements.controlsContainer.classList.remove('fade_out');
    DOMElements.controlsContainer.classList.add('fade_in');
  }

  muteToggle() {
    if (0 !== this.persistent.volume && !this.persistent.muted) {
      this.persistent.volume = 0;
      this.persistent.muted = true;
    } else {
      this.persistent.volume = this.persistent.latestVolume;
      this.persistent.muted = false;
    }
    this.client.volume = this.persistent.volume;
  }

  onVolumeBarMouseDown(event) {
    const shiftVolume = (volumeBarX) => {
      const totalWidth = DOMElements.volumeControlBar.clientWidth;

      if (totalWidth) {
        let newVolume = volumeBarX / totalWidth * 3;

        if (newVolume < 0.05) {
          newVolume = 0;
          this.persistent.muted = true;
        } else if (newVolume > 2.95) {
          newVolume = 3;
        }

        if (newVolume > 0.92 && newVolume < 1.08) {
          newVolume = 1;
        }

        if (this.persistent.muted && newVolume > 0) {
          this.persistent.muted = false;
        }
        this.client.volume = newVolume;
      }
    };

    const onVolumeBarMouseMove = (event) => {
      const currentX = event.clientX - WebUtils.getOffsetLeft(DOMElements.volumeContainer) - 10;
      shiftVolume(currentX);
    };

    const onVolumeBarMouseUp = (event) => {
      document.removeEventListener('mousemove', onVolumeBarMouseMove);
      document.removeEventListener('touchmove', onVolumeBarMouseMove);
      document.removeEventListener('mouseup', onVolumeBarMouseUp);
      document.removeEventListener('touchend', onVolumeBarMouseUp);

      const currentX = event.clientX - WebUtils.getOffsetLeft(DOMElements.volumeContainer) - 10;

      if (!isNaN(currentX)) {
        shiftVolume(currentX);
      }
    };

    document.addEventListener('mouseup', onVolumeBarMouseUp);
    document.addEventListener('touchend', onVolumeBarMouseUp);
    document.addEventListener('mousemove', onVolumeBarMouseMove);
    document.addEventListener('touchmove', onVolumeBarMouseMove);
  }

  updatePlaybackRate() {
    this.playbackRateChanger.setPlaybackRate(this.persistent.playbackRate, true);
  }

  updateLanguageTracks() {
    this.languageChanger.updateLanguageTracks(this.client);
  }

  updateQualityLevels() {
    this.videoQualityChanger.updateQualityLevels(this.client);
  }

  updateVolumeBar() {
    const currentVolumeTag = DOMElements.currentVolume;
    const muteButtonTag = DOMElements.muteBtn;

    const volume = this.persistent.volume;

    if (0 !== volume) {
      this.persistent.latestVolume = volume;
      this.persistent.muted = false;
    } else {
      this.persistent.muted = true;
    }
    if (this.persistent.muted) {
      muteButtonTag.classList.add('muted');
    } else {
      muteButtonTag.classList.remove('muted');
    }

    currentVolumeTag.style.width = (volume * 100) / 3 + '%';
    DOMElements.currentVolumeText.textContent = Math.round(volume * 100) + '%';
  }

  timeUpdated() {
    const duration = this.client.duration;
    DOMElements.currentProgress.style.width = Utils.clamp(this.persistent.currentTime / duration, 0, 1) * 100 + '%';
    DOMElements.duration.textContent = StringUtils.formatTime(this.persistent.currentTime) + ' / ' + StringUtils.formatTime(duration);

    const chapters = this.client.chapters;
    if (chapters.length > 0) {
      const time = this.persistent.currentTime;
      const chapter = chapters.find((chapter) => chapter.startTime <= time && chapter.endTime >= time);
      if (chapter) {
        this.setStatusMessage('chapter', chapter.name, 'info');
      }
    } else {
      this.setStatusMessage('chapter', null, 'info');
    }

    this.subtitlesManager.renderSubtitles();
    this.subtitlesManager.subtitleSyncer.onVideoTimeUpdate();
    this.updateSkipSegments();
  }

  fullscreenToggle() {
    try {
      if (document.fullscreenEnabled) {
        if (!document.fullscreenElement) {
          DOMElements.playerContainer.requestFullscreen();
        } else if (document.exitFullscreen) {
          document.exitFullscreen();
        }

        this.updateFullScreenButton();
      } else {
        if (EnvUtils.isExtension()) {
          chrome.runtime.sendMessage({
            type: 'request_fullscreen',
          }, (response)=>{
            this.setFullscreenStatus(response === 'enter');
          });
        }
      }
    } catch (e) {
      console.log('Fullscreen not supported', e);
    }
  }

  updateFullScreenButton() {
    this.setFullscreenStatus(document.fullscreenElement);
  }

  setFullscreenStatus(status) {
    const fullScreenButton = DOMElements.fullscreen;
    if (status) {
      fullScreenButton.classList.add('out');
    } else {
      fullScreenButton.classList.remove('out');
    }
  }

  playPauseToggle() {
    if (!this.client.player) return;

    if (!this.persistent.playing) {
      this.client.play();
    } else {
      this.client.pause();
    }
  }

  play() {
    const previousValue = this.persistent.playing;
    this.persistent.playing = true;
    this.hideBigPlayButton();
    this.updatePlayPauseButton();
    if (!previousValue) {
      this.playPauseAnimation();
      this.queueControlsHide();
    }
  }

  pause() {
    const previousValue = this.persistent.playing;
    this.persistent.playing = false;
    this.updatePlayPauseButton();
    this.showControlBar();
    if (previousValue) {
      this.playPauseAnimation();
    }
  }

  updatePlayPauseButton() {
    const playButton = DOMElements.playPauseButton;
    const playButtonBig = DOMElements.playPauseButtonBig;
    if (this.persistent.playing) {
      playButton.classList.add('playing');
      playButtonBig.classList.replace('fluid_initial_play_button', 'fluid_initial_pause_button');
    } else {
      playButton.classList.remove('playing');
      playButtonBig.classList.replace('fluid_initial_pause_button', 'fluid_initial_play_button');
    }
  }

  isUserSeeking() {
    return this.progressBar.isSeeking || this.subtitlesManager.subtitleSyncer.isSeeking;
  }

  playPauseAnimation() {
    if (this.isUserSeeking()) {
      return;
    }
    DOMElements.playPauseButtonBigCircle.classList.remove('transform-active');
    void DOMElements.playPauseButtonBigCircle.offsetWidth;
    DOMElements.playPauseButtonBigCircle.classList.add('transform-active');
    setTimeout(
        function() {
          DOMElements.playPauseButtonBigCircle.classList.remove('transform-active');
        },
        450,
    );
  }
}
