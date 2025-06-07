import { utils } from '../core/utils.js';
import { game } from '../core/Game.js';
import {
  DEFAULT_FPS,
  defaultMissileMode,
  demo,
  GAME_SPEED,
  GAME_SPEED_INCREMENT,
  GAME_SPEED_MAX,
  GAME_SPEED_MIN,
  getTypes,
  isiPhone,
  isMobile,
  oneOf,
  onPreferHiDPIChange,
  setFrameRate,
  soundManager,
  tutorialMode,
  TYPES,
  updateGameSpeed,
  updateRadarTheme
} from '../core/global.js';
import {
  initBNBSFX,
  playQueuedSounds,
  playSound,
  sounds
} from '../core/sound.js';
import { playSequence, resetBNBSoundQueue } from '../core/sound-bnb.js';
import { sprites } from '../core/sprites.js';
import { effects } from '../core/effects.js';
import { net } from '../core/network.js';
import { common } from '../core/common.js';
import { gameMenu } from './game-menu.js';
import {
  calculateIQ,
  filterLevelData,
  getBalance,
  getFlagsByLevel,
  getLevelOffset,
  levelFlags,
  networkBattles,
  normalizeLevelData,
  originalLevels,
  previewLevel,
  setLevel
} from '../levels/default.js';
import { snowStorm } from '../lib/snowstorm.js';
import { aaLoader } from '../core/aa-loader.js';
import { gamepad } from './gamepad.js';
import { updateDomFettiContext } from './DomFetti.js';

const prefs = {
  gameType: 'game_type'
};

// for non-boolean form values; set by form, referenced by game
const PREFS = {
  SHOW_HEALTH_NEVER: 'never',
  SHOW_HEALTH_SOMETIMES: 'sometimes',
  SHOW_HEALTH_ALWAYS: 'always',
  NOTIFICATIONS_LOCATION_LEFT: 'left',
  NOTIFICATIONS_LOCATION_RIGHT: 'right'
};

const DEFAULT_VOLUME_MULTIPLIER = 0.7;

// game defaults
const defaultPrefs = {
  'auto_flip': !!isMobile,
  'game_fps': DEFAULT_FPS,
  'game_fps_auto': 1,
  'game_speed': 1,
  'game_speed_pitch': false,
  'gfx_hi_dpi': true,
  'game_type': 'easy', // [easy|hard|extreme|armorgeddon]
  'gamepad': true,
  'net_game_level': '',
  'net_game_type': 'easy', // non-network default is tutorial, need to be explicit.
  'net_game_style': 'pvp', // [pvp|pvp_cpu|coop_2v1|coop_2v2]
  'lock_step': false,
  'net_player_name': '',
  'net_remote_player_name': '',
  'sound': !window.location.search.match(/mute/i),
  'volume': DEFAULT_VOLUME_MULTIPLIER, // 0-1
  'muzak': true,
  'bnb': false,
  'bnb_tv': true,
  'weather': '', // [none|rain|hail|snow|turd]
  'domfetti': true,
  'radar_interference_blank': true,
  'gravestones_helicopters': true,
  'gratuitous_battle_over': true,
  'gravestones_infantry': demo || false,
  'gravestones_vehicles': demo || false,
  'unlimited_inventory': false,
  'landing_pads_on_radar': true,
  'radar_enhanced_fx': demo || isMobile || false,
  'last_battle': null,
  'mobile_controls_location': isMobile ? 'left' : 'right', // "mobile" is gamepad UI on desktop.
  'radar_theme': 'classic',
  'super_bunker_arrows': true,
  'show_inventory': true,
  'show_weapons_status': true,
  'show_keyboard_labels': !isiPhone, // iPhone is unlikely to have a keyboard. iPad might. Desktops should, etc.
  'show_game_tips': true,
  'show_health_status': PREFS.SHOW_HEALTH_SOMETIMES, // never | sometimes | always
  'stars_color': true,
  'stars_density': 'standard',
  'stars_twinkle_fx': true,
  'stars_warp_fx': true,
  // special case: mobile defaults to show @ left, important especially on small screens in portrait mode.
  'notifications_location': isMobile
    ? PREFS.NOTIFICATIONS_LOCATION_RIGHT
    : PREFS.NOTIFICATIONS_LOCATION_RIGHT,
  'notifications_order_bottom_up': true,
  'notify_engineer': true,
  'notify_infantry': true,
  'notify_missile-launcher': true,
  'notify_smart-missile': true,
  'notify_tank': true,
  'notify_van': true,
  'alt_smart_missiles': !isMobile,
  'modern_smart_missiles': true,
  'engineers_repair_bunkers': true,
  'engineers_rob_the_bank': true,
  'tank_gunfire_miss_bunkers': true,
  'ground_unit_traffic_control': true,
  'clouds_on_radar': true,
  'weapons_interval_classic': false,
  'radar_scaling': true,
  'scan_ui_battlefield_enemy': true,
  'scan_ui_battlefield_friendly': true,
  'scan_ui_radar_enemy': true,
  'scan_ui_radar_friendly': true,
  'unlimited_lives': true,
  'webhook_url': ''
};

// certain prefs should be treated as numbers.
const numericPrefs = {
  volume: true,
  game_speed: true,
  game_fps: true,
  game_fps_auto: true
};

// allow URL-based overrides of prefs
let prefsByURL = {};

const appleWatch = '<span class="mac-system-waiting"></span>';

function normalizePrefValue(name, val) {
  // string / number to boolean, etc.

  // not a true/false string, but a floating-point number
  if (!isNaN(val) && !Number.isInteger(val)) return val;

  // special case - game speed can be 1, but needs to remain a number.
  if (name === 'game_speed') return val;

  if (val === 'true' || val == 1) return true;
  if (val === 'false' || val == 0) return false;
  return val;
}

const { hash } = window.location;
const hashParams = hash?.substring(hash.indexOf('#') === 0 ? 1 : 0);
const searchParams = new URLSearchParams(window.location.search || hashParams);

for (const p of searchParams) {
  // p = [name, value]
  if (defaultPrefs[p[0]] !== undefined) {
    console.warn(`Applying URL pref override: ${p[0]}=${p[1]}`);
    prefsByURL[p[0]] = normalizePrefValue(p[0], p[1]);
  }
}

// initially, the game inherits the defaults
let gamePrefs = {
  ...defaultPrefs
};

function PrefsManager() {
  let data, dom, events;

  function init(callback) {
    if (data.initComplete) {
      // this shouldn't happen, but just in case...
      callback?.();
      return;
    }

    const placeholder = document.getElementById('game-prefs-modal-placeholder');

    if (!placeholder.hasChildNodes()) {
      // fetch the preferences HTML fragment
      aaLoader.loadHTML('game-prefs-modal.html', (response) => {
        placeholder.innerHTML = response;
        // and redo when complete.
        init(callback);
      });
      return;
    }

    dom.o = document.getElementById('game-prefs-modal');
    dom.oBnB = document.getElementById('cb_bnb');
    dom.oChatScroll = document.getElementById('network-options-chat-scroll');
    dom.oChatUI = document.getElementById('network-options-chat-ui');
    dom.oForm = document.getElementById('game-prefs-form');
    dom.oFormSubmit = document.getElementById('game-prefs-submit');
    dom.oFormScroller = document.getElementById('form-scroller');
    dom.oFormCancel = document.getElementById('game-prefs-cancel');
    dom.oGameSpeedSlider = document.getElementById('input_game_speed');
    dom.oNetStatusLabel = document.getElementById(
      'network-options-status-label'
    );
    dom.oVolumeSlider = document.getElementById('main_volume');
    dom.oStatsBar = document.getElementById('stats-bar');
    dom.oGameTips = document.getElementById('game-tips');
    dom.oShowChangelog = document.getElementById('show-changelog');

    // just in case
    if (!dom.o || !dom.oForm || !dom.optionsLink) return;

    // delightfully old-skool.
    dom.oForm.onsubmit = events.onFormSubmit;
    dom.oForm.onreset = events.onFormReset;

    // Configure game speed slider, based on JS values.
    // Slider goes down to 0 for consistency, but limit the math to GAME_SPEED_MIN.
    dom.oGameSpeedSlider.min = 0;
    dom.oGameSpeedSlider.max = GAME_SPEED_MAX;
    dom.oGameSpeedSlider.step = GAME_SPEED_INCREMENT;

    // network game + custom level case
    const customGroup = gameMenu.getCustomGroup();

    if (customGroup) {
      addGroupAndLevel(customGroup.cloneNode(true));
    }

    readAndApplyPrefsFromStorage();

    // hackish / special-case: force-update notification toast location IF it's on the left.
    // page HTML + CSS defaults to the right.
    if (
      gamePrefs.notifications_location === PREFS.NOTIFICATIONS_LOCATION_LEFT
    ) {
      events.onPrefChange['notifications_location'](
        gamePrefs.notifications_location
      );
    }

    // similar for bottom-up toasts.
    if (gamePrefs.notifications_order_bottom_up) {
      events.onPrefChange['notifications_order_bottom_up'](
        gamePrefs.notifications_order_bottom_up
      );
    }

    // special case: apply certain prefs with current values at init.
    [
      'gravestones_helicopters',
      'gravestones_infantry',
      'gravestones_vehicles',
      'mobile_controls_location',
      'notifications_location',
      'radar_enhanced_fx',
      'radar_scaling'
    ].forEach((pref) => events.onPrefChange[pref](gamePrefs[pref], pref));

    // special case: apply BnB "VS" immediately.
    dom.oBnB.addEventListener('change', (e) =>
      events.onPrefChange['bnb'](e.target.checked)
    );

    dom.oGameSpeedSlider.addEventListener('input', events.onGameSpeedInput);
    dom.oVolumeSlider.addEventListener('change', events.onVolumeChange);
    dom.oVolumeSlider.addEventListener('input', events.onVolumeInput);

    const prefVersion = document.getElementById('prefs-modal-version');

    if (prefVersion && window.aaVersion) {
      const v = window.aaVersion.substring(1);
      const versionString = [
        v.substring(0, 4),
        v.substring(4, 6),
        v.substring(6)
      ].join('.');
      prefVersion.innerText = versionString;
    }

    utils.events.add(dom.oShowChangelog, 'click', events.fetchChangelog);

    let bnbSoundActive;

    // special case.
    utils.events.add(
      document.getElementById('prefs_radio_game_type_hard'),
      'change',
      () => {
        // if BnB, react appropriately. 🤣
        if (!gamePrefs.bnb || bnbSoundActive) return;

        bnbSoundActive = true;
        playSound(sounds.bnb.gameMenuHard, null, {
          onfinish: () => (bnbSoundActive = false)
        });
      }
    );

    // "more info" show/hide links
    dom.o.querySelectorAll('.more-info-toggle').forEach((o) => {
      utils.events.add(o, 'click', events.moreInfoHandler);
    });

    data.initComplete = true;

    callback?.();
  }

  function updateChangelog() {
    data.changelogVisible = !data.changelogVisible;
    dom.oShowChangelog.removeAttribute('disabled');
    dom.oShowChangelog.getElementsByTagName('span')[0].innerHTML =
      data.changelogVisible ? 'Hide' : 'Show';
    if (gamepad.data.active) {
      dom.oShowChangelog.focus();
      // invalidate layout, since content height has changed.
      data.layoutCache = {};
    }
  }

  function maybeTruncate(url) {
    // github commit-to-short-hash shenanigans
    const base = 'https://github.com/scottschiller/ArmorAlley/commit/';
    const offset = url.indexOf(base);
    if (offset !== -1) {
      const start = offset + base.length;
      const hashLength = 7;
      return url.substring(start, start + hashLength);
    }
    return url.substr(url.indexOf('//') + 2);
  }

  function mungeURL(match) {
    return `<a href="${match}" target="_blank">${maybeTruncate(match)}</a>`;
  }

  function parseChangelog(text) {
    var urlPattern =
      /(\b(https?):\/\/[-A-Z0-9+&@#\/%?=~_|!:,.;]*[-A-Z0-9+&@#\/%=~_|])/gim;

    return (
      text
        // escape
        .replace(/</g, '&lt')
        .replace(/>/g, '&gt')

        // URLs to links
        .replace(urlPattern, mungeURL)

        // quick-and-dirty markdown shenanigans, single-line parsing

        // `text` -> <code>text</code>
        .replace(/`(.[^\n]*?)`/g, '<code>$1</code>')

        // *text* -> <b>text</b>
        .replace(/\*(.[^\*]*?)\*/g, '<b>$1</b>')

        // _text_ -> <u>text</u>
        .replace(/\_(.[^\_]*?)\_/g, '<i>$1</i>')

        // newlines
        .replace(/(?:\r\n|\r|\n)/g, '<br>')

        // indentation
        .replace(/  /gi, '&hairsp;')
    ); // hair-space
  }

  function queuedSoundHack() {
    // ugh. ensure we keep processing sounds.
    if (!gamePrefs.bnb && game.data.paused) {
      // hack: use classic timer, since the DIY setFrameTimeout() won't work when paused.
      if (!game.data.hackTimer) {
        game.data.hackTimer = window.setTimeout(() => {
          game.data.hackTimer = null;
          playQueuedSounds();
        }, 32);
      }
    }
  }

  function selectLevel(levelName) {
    setLevel(levelName, levelName);
    previewLevel(levelName);
  }

  function renderGameSpeedSlider() {
    let slider = document.getElementById('game_speed-value');
    if (!slider) return;
    slider.innerText = `${Math.round(gamePrefs.game_speed * 100)}%`;
    slider = null;
  }

  function renderVolumeSlider() {
    document.getElementById('volume-value').innerText = `${parseInt(
      gamePrefs.volume * 100,
      10
    )}%`;
  }

  function getVolumeFromSlider() {
    // volume slider goes from 0-10; we store values in JS as 0-1 as a volume "scale."
    return parseFloat((dom.oVolumeSlider.value * 0.1).toFixed(2));
  }

  function getGameSpeedFromSlider() {
    // game speed slider goes from 0-10; we store values in JS as 0.25 - 2.
    return dom.oGameSpeedSlider.value;
  }

  function toggleDisplay() {
    if (data.active) {
      hide();
    } else {
      show();
    }
  }

  function updateNetworkStatus(status) {
    const statusHTML = '🌐 &hairsp;Network';

    dom.oNetStatusLabel.innerHTML = `${statusHTML}: ${status}`;
  }

  function doHostSetup(id) {
    updateNetworkStatus('Ready');

    const inviteButton = document.getElementById('network-options-invite-link');

    inviteButton.disabled = '';

    inviteButton.onclick = () => {
      events.onInvite(id);
    };
  }

  function startNetwork() {
    updateNetworkStatus('Initializing...');

    resetPlayerNames();

    events.onChat('Welcome to network chat!');

    if (net.isHost) {
      events.onChat('Waiting for the guest to join...');
    } else {
      events.onChat('Connecting...');

      window.setTimeout(() => {
        if (net.connected) return;

        updateNetworkStatus(`Connecting... ${appleWatch}☎️`);
      }, 1000);

      window.setTimeout(() => {
        if (net.connected) return;

        updateNetworkStatus(`Still connecting... ${appleWatch}😅`);
        events.onChat('Still connecting...😅');

        window.setTimeout(() => {
          updateNetworkStatus(`Connection trouble 😬😒`);
          events.onChat(
            '<b>Unable to connect; apologies.</b> Try reloading, then getting a new invite link.'
          );
          events.onChat(
            'This game uses PeerJS to establish a peer-to-peer WebRTC session.'
          );
          events.onChat(
            'This may fail in a "double NAT" case from some routers &amp; firewalls, often used at offices and schools. 😞'
          );
          if (!net.debugNetwork) {
            events.onChat(
              'For technical detail, try reloading with network debug logging.'
            );
            events.onChat(
              `<button type="button" onclick="window.location.href += '&debugNetwork=1'">Network debug mode</button>`
            );
          }
        }, 6500);
      }, 5000);
    }

    net.init(
      (id) => {
        if (net.isHost) {
          doHostSetup(id);
        }

        // handlers for radio buttons + checkboxes, keeping things in sync

        function handleInputChange(e) {
          if (!e?.target) return;

          let { name, value } = e.target;

          if (e.target.type === 'checkbox') {
            // NOTE: assuming 0/1 values here, no "true" strings etc. for checkboxes.
            if (value != 0 && value != 1) {
              console.warn(
                'handleInputChange(): WTF, checkbox has value other than 0|1?',
                e.target
              );
              return;
            }
            value = e.target.checked ? value : value == 1 ? 0 : 1;
          }

          if (!name) return;

          // note: convert form string to boolean for game prefs object
          value = normalizePrefValue(name, value);

          gamePrefs[name] = value;

          // hackish: if level, update local model.
          if (name === 'net_game_level') {
            selectLevel(value);
          }

          // game style now affects level preview, whether CPU vehicles are included or not.
          if (name === 'net_game_style') {
            selectLevel(gamePrefs.net_game_level);
          }

          // special case: show toast for local user.
          if (game.data.started) {
            if (name === 'lock_step') {
              game.objects.notifications.add(
                `You have ${
                  value ? 'enabled' : 'disabled'
                } "lock step" game sync.`
              );
              if (!value) {
                // if disabling, ensure the spinner gets turned off.
                game.objects.gameLoop.setWaiting(false);
              }
            } else if (name === 'ground_unit_traffic_control') {
              game.objects.notifications.add(
                `You have ${
                  value ? 'enabled' : 'disabled'
                } Ground Vehicle "Traffic Control."`
              );
            }
          }

          if (net.connected) {
            net.sendMessage({
              type: 'UPDATE_PREFS',
              params: [{ name, value }]
            });
          }

          // if we were "ready" to start, we changed our mind - so, reset accordingly.
          events.onReadyState(false);
        }

        // change events on prefs "panels" and specific ID(s) that need syncing with remote
        [
          'network-options',
          'input_game_speed',
          'game-fps-pref',
          'gameplay-options',
          'traffic-control'
        ].forEach((id) =>
          document
            .getElementById(id)
            .addEventListener('change', handleInputChange)
        );

        const chatInput = document.getElementById('network-chat-input');

        function changeHandler(e) {
          if (!net.connected) return;

          const text = chatInput.value;

          const params = [text, gamePrefs.net_player_name];

          // ignore if empty
          if (!text.length) {
            e.preventDefault();
            return;
          }

          // send to remote, before anything else.
          net.sendMessage({ type: 'CHAT', params });

          // check for slash command.
          // NOTE: explicit pass of false, so we send a chat message with this local command call.
          const fromNetwork = false;
          const slashCommand = common.parseSlashCommand(text, fromNetwork);

          if (slashCommand) {
            slashCommand();
          } else {
            // show the message locally
            events.onChat(...params);
          }

          // and clear.
          chatInput.value = '';

          e.preventDefault();
          return false;
        }

        chatInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') return changeHandler(e);
        });

        // just in case - iOS and others.
        chatInput.addEventListener('change', changeHandler);
      },
      () => {
        if (net.isHost) {
          events.onChat('Your guest has connected.');

          // if we have a name set, send it over.
          net.sendMessage({
            type: 'REMOTE_PLAYER_NAME',
            newName: gamePrefs.net_player_name
          });

          // grab groups of inputs, grouped by `<legend>` for shared "sync over network" sections.
          // radio buttons share the same name, so we'll have duplicates that need filtering.
          // hackish: assign all to an object, then return the keys.
          let sharedPrefNames = {};

          dom.oForm
            .querySelectorAll(
              '.sync-over-network input, .sync-over-network select'
            )
            .forEach((input) => (sharedPrefNames[input.name] = true));

          const prefsToSend = Object.keys(sharedPrefNames);

          const params = prefsToSend.map((key) => ({
            name: key,
            value: gamePrefs[key]
          }));

          net.sendMessage({ type: 'UPDATE_PREFS', params });
        } else {
          events.onChat('Connection established with host.');
          if (net.debugNetwork) {
            events.onChat(
              'NOTE: Network OK. Disable debugging for smoother network gameplay.'
            );
            events.onChat(
              `<button type="button" onclick="window.location.href = window.location.href.substring(0, window.location.href.indexOf('&debugNetwork=1'))">Disable network debug mode</button>`
            );
          }
        }

        events.onChat(
          'Discuss options amongst yourselves, and click "READY" to proceed.'
        );

        events.onChat('Set your name by typing /name [your name here]');

        const chatInput = document.getElementById('network-chat-input');

        chatInput.placeholder = 'Type a message, enter/return to send';
        chatInput.disabled = false;
      }
    );
  }

  function maybeUpdateGameSpeed() {
    /**
     * tl;dr: we may not yet have established a default game speed yet.
     * It's possible gamePrefs.game_speed is 0/false, but we don't want to assume 1.
     * For mobile / touch devices, we may have a slightly lower default speed.
     */
    if (!gamePrefs.game_speed) {
      gamePrefs.game_speed = updateGameSpeed();
    }
  }

  function show(options = {}) {
    // preload CSS and then do the actual thing
    aaLoader.loadCSS('aa-prefs-and-modals.css', () => {
      if (data.initComplete) {
        showForReal(options);
      } else {
        // fetch HTML fragment, append, then show
        // TODO: simultaneous vs. sequential HTML + CSS fetch
        init(() => showForReal(options));
      }
    });
  }

  function updateBattleLists() {
    dom.o
      .querySelectorAll('.battle-list')
      ?.forEach((list) => updateBattleList(list));
  }

  function updateBattleList(list) {
    let inputs = list.querySelectorAll('input');
    if (!inputs.length) return;

    inputs.forEach((input) =>
      renderBattleRow(input.getAttribute('value'), input)
    );
  }

  function renderBattleRow(levelName, inputNode) {
    let data = normalizeLevelData(
      originalLevels[levelName] || networkBattles[levelName]
    );

    if (!data) return;

    // TODO: externalize, make a method or something
    const excludeVehicles =
      data.network &&
      gamePrefs.net_game_style.match(/coop/) &&
      levelName != 'Custom Level';

    data = filterLevelData(data, excludeVehicles);

    let flags = getFlagsByLevel(levelName);

    // render battle / level row in menu
    let html = [];

    // fixed-width
    let spacing = ' '.repeat(15 - levelName.length);
    html.push(levelName + spacing);

    Object.keys(flags).forEach((key) =>
      html.push(flags[key] ? '<b>•</b>' : '<s>•</s>')
    );

    // fairness
    let balance = getBalance(data);

    // equal spacing
    html.push((balance > 0 ? '+' : balance === 0 ? ' ' : '') + balance);

    // IQ
    let offset = getLevelOffset(levelName);

    let iq = calculateIQ(
      offset.isCampaign ? 'campaign' : 'network',
      offset.value
    );

    // right-align and ensure 3-character-wide IQ results.
    if (!iq) {
      // "empty" (tutorial or not-found) case
      iq = ' --';
    } else if (iq < 10) {
      iq = `  ${iq}`;
    } else if (iq < 100) {
      iq = ` ${iq}`;
    }

    html.push(iq);

    if (inputNode) {
      inputNode.parentNode.querySelector('pre').innerHTML = html.join(' ');
    }
  }

  function setDefaultFocus() {
    let focusTarget;

    if (data.network) {
      focusTarget = dom.oFormCancel;
    } else if (data.whatsNew) {
      focusTarget = dom.oFormSubmit;
    } else if (data.selectLevel) {
      focusTarget = dom.o.querySelector('[data-focus-start-here]');
    }

    gamepad.setFocus(focusTarget || dom.oFormSubmit);
  }

  function showForReal(options = {}) {
    /**
     * options = {
     *   network: true,
     *   selectLevel: true,
     *   whatsNew: true,
     *   // expect game_type to be one of easy / hard / extreme
     *   onStart: (networkGameType) => startGame(networkGameType),
     *   onShowComplete: () => optional callback
     * };
     */

    if (data.active || !dom.o) return;

    data.lastActiveElement = document.activeElement;

    data.layoutCache = {};

    data.active = true;

    data.network = !!options.network;

    data.selectLevel = !!options.selectLevel;

    data.whatsNew = !!options.whatsNew;

    game.objects.view.data.ignoreMouseEvents = true;

    // select mode (or not)
    utils.css.addOrRemove(dom.o, options.selectLevel, 'select-level');
    utils.css.addOrRemove(dom.o, options.whatsNew, 'whats-new');

    document.body.appendChild(dom.o);

    utils.css.add(document.body, 'prefs-modal-open');

    dom.o.style.display = 'block';

    maybeUpdateGameSpeed();

    if (options.network) {
      // hackish: ensure game type migrates to "easy" from unassigned / default "tutorial"
      if (gamePrefs.net_game_type === 'tutorial') {
        gamePrefs.net_game_type = 'easy';
      }
      // catch network game difficulty and update modal / battle list accordingly
      document
        .querySelectorAll('input[name="net_game_type"]')
        .forEach((radio) => {
          utils.events.add(radio, 'change', (e) => {
            // hackish: assign pref right away.
            gamePrefs.net_game_type = e.target.value;
            updateBattleLists();
          });
        });
    } else {
      updateBattleLists();

      setDefaultFocus();

      const fieldset = document.getElementById('prefs-select-level');

      utils.events.add(fieldset, 'change', events.onLevelSelect);

      const difficulty = document.getElementById('prefs-game-difficulty');

      utils.events.add(difficulty, 'change', events.onDifficultySelect);
    }

    // ensure the form matches the JS state.
    updateForm();

    if (options.selectLevel) {
      // hackish: ensure the modal matches the game menu selection.
      const levelName = document.getElementById('game_level').value;
      const radio = document.querySelector(
        `#prefs-select-level input[value="${levelName}"]`
      );
      if (radio) radio.checked = true;
      // force preview / radar redraw
      let force = true;
      previewLevel(levelName, force);
    } else {
      updateGamepadList();
    }

    if (options.whatsNew) {
      events.fetchWhatsNew();
    }

    // ensure the volume slider is up-to-date.
    dom.oVolumeSlider.value = gamePrefs.volume * 10;

    // heh.
    data.bnbVolumeTestSound = oneOf(sounds.bnb.volumeTestSounds);

    renderVolumeSlider();

    // only do the network connect flow once, of course.
    if (data.network && !data.connected) {
      // hackish: grab network level selection from home menu, and apply to prefs.
      // by default, check drop-down.
      let netGameLevel = document.getElementById('game_level').value;
      // if tutorial, check stored pref with fallback.
      if (netGameLevel === 'Tutorial') netGameLevel = gamePrefs.net_game_level;
      if (!netGameLevel || netGameLevel === 'Tutorial')
        netGameLevel = 'Cavern Cobra';

      gamePrefs.net_game_level = netGameLevel;

      // select the matching item in the prefs modal list.
      let radio = document.querySelector(
        `#network-options input[name="net_game_level"][value="${netGameLevel}"]`
      );

      if (radio) {
        radio.checked = true;
      }

      // and, update local model.
      selectLevel(gamePrefs.net_game_level);

      // browsers may remember scroll offset through reloads; ensure it resets.
      dom.oFormScroller.scrollTop = 0;

      utils.css.add(document.body, 'network');

      // network LIGHTS.EXE requires the game loop; so be it.
      game.objects.gameLoop.start();

      utils.css.addOrRemove(dom.o, data.network, 'is-network');
      utils.css.addOrRemove(dom.o, data.network && net.isGuest, 'is-guest');
      utils.css.addOrRemove(dom.o, data.network && net.isHost, 'is-host');

      dom.oFormSubmit.innerHTML = 'READY';

      // manually disable button, until the network is connected.
      // this is separate from the "ready to start" logic.
      dom.oFormSubmit.disabled = true;

      startNetwork();
    } else {
      dom.oFormSubmit.innerHTML = 'OK';

      // ensure this is active - may have been disabled during network flow
      dom.oFormSubmit.disabled = false;
    }

    const now = Date.now();

    if (gamePrefs.bnb) {
      if (now - data.lastMenuOpen > data.lastMenuOpenThrottle) {
        data.lastMenuOpen = now;

        window.setTimeout(() => {
          if (!data.active) return;

          playSequence(
            oneOf([
              sounds.bnb.menuOpenV1,
              sounds.bnb.menuOpenV2,
              sounds.bnb.menuOpenV3
            ]),
            null,
            () => data.active
          );

          // hackish BnB case: ensure what we may have just queued gets heard.
          playQueuedSounds();
        }, 500);
      } else {
        playSound(sounds.bnb.beavisPoop);
      }
    }

    // hackish BnB case: ensure what we may have just queued gets heard.
    playQueuedSounds();

    game.pause({ noMute: true });

    // optional callback
    options?.onShowComplete?.();
  }

  function hide() {
    if (!data.active || !dom.o) return;

    gamepad.resetSelected();

    dom.o.remove();
    data.active = false;

    // reset "display mode" flags
    data.network = false;
    data.whatsNew = false;
    data.selectLevel = false;

    utils.css.remove(document.body, 'prefs-modal-open');

    game.objects.view.data.ignoreMouseEvents = false;

    // tutorial also uses modals CSS.
    if (!tutorialMode) {
      aaLoader.unloadCSS('aa-prefs-and-modals.css');
    }

    if (gamePrefs.bnb) {
      data.didCrankIt = false;
    }

    // return focus to where it was
    if (gamePrefs.gamepad && gamepad.data.active) {
      try {
        gamepad.setFocus(data.lastActiveElement);
      } catch (e) {
        console.warn(
          'Failed to focus last active element',
          data.lastActiveElement
        );
      }
    }

    data.lastActiveElement = null;

    game.resume();
  }

  const isActive = () => data.active;

  function getEmptyCheckboxData() {
    // checkbox inputs that aren't checked, won't be submitted.
    // iterate through those here, and provide the name with value=0 for each.
    // there is likely a cleaner way to do this.
    if (!dom.oForm) return {};

    let result = {};
    let checkboxes = dom.oForm.querySelectorAll(
      'input[type="checkbox"]:not(:checked)'
    );

    checkboxes.forEach((checkbox) => {
      result[checkbox.name] = 0;
    });

    return result;
  }

  function getPrefsFromForm() {
    if (!dom.oForm) return;

    const formData = new FormData(dom.oForm);

    if (!formData) return;

    let data = {};

    formData.forEach((value, key) => {
      // NOTE: form uses numbers, but game state tracks booleans.
      // form values will be 0, 1, or a non-numeric string.
      // try for int, e.g., "0" -> 0 - otherwise, keep original string.
      let number = parseInt(value, 10);
      if (key === 'webhook_url') {
        // hack: guard against null / false etc.
        data[key] = value || '';
      } else {
        data[key] = isNaN(number) ? value : number;
      }
    });

    // special case: sliders.
    // TODO: DRY + fix this anti-pattern.
    data[dom.oVolumeSlider.name] = getVolumeFromSlider();
    data[dom.oGameSpeedSlider.name] = getGameSpeedFromSlider();

    // mixin of e.g., sound=0 where checkboxes are unchecked, and remainder of form data
    let prefs = {
      ...getEmptyCheckboxData(),
      ...data
    };

    return prefs;
  }

  function convertPrefsForGame(prefs) {
    // all form values are integer-based, but the game references booleans and string values.
    // given prefs with 0|1 or integer, translate to boolean or string values.
    if (!prefs) return {};

    let result = {};
    let value;

    for (let key in prefs) {
      // NOTE: form uses numbers, but game state tracks booleans.
      // key -> value: 0/1 to boolean; otherwise, keep as string.
      value = prefs[key];
      result[key] = isNaN(value) || numericPrefs[key] ? value : !!value;
    }

    return result;
  }

  function updatePrefs() {
    // fetch from the live form
    let formPrefs = getPrefsFromForm();

    // convert 0/1 to booleans
    let newGamePrefs = convertPrefsForGame(formPrefs);

    applyNewPrefs(newGamePrefs);
  }

  function addGroupAndLevel(oGroup) {
    if (!dom.o) return;
    const oLevelSelect = dom.o.querySelector('[name="net_game_level"]');
    if (!oLevelSelect) return;

    oLevelSelect.appendChild(oGroup);

    if (oLevelSelect.options?.length) {
      oLevelSelect.selectedIndex = oLevelSelect.options.length - 1;
    }
  }

  function applyNewPrefs(newGamePrefs, force) {
    let prefChanges = [];

    // queue data for onChange() calls, as applicable
    // e.g., game needs to handle enabling or disabling snow or health bars
    for (let key in newGamePrefs) {
      if (
        events.onPrefChange[key] &&
        (gamePrefs[key] !== newGamePrefs[key] || force)
      ) {
        prefChanges.push({ key, value: newGamePrefs[key] });
      }
    }

    // update the live game prefs
    gamePrefs = {
      ...gamePrefs,
      ...newGamePrefs
    };

    // and now, fire all the pref change events.
    prefChanges.forEach((item) => {
      events.onPrefChange[item.key](item.value, item.key);
    });
  }

  function updateForm() {
    // form may not be ready yet...
    if (!data.initComplete) return;

    // given current `gamePrefs`, ensure the form has the right things selected / checked.
    Object.keys(gamePrefs).forEach((key) => {
      let value = boolToInt(gamePrefs[key]);

      // find the matching input(s) based on name, and update it.
      let inputs = dom.oForm.querySelectorAll(`input[name="${key}"]`);

      // just in case...
      if (!inputs?.forEach) return;

      inputs.forEach((input) => {
        if (input.type === 'text' || input.type === 'url') {
          // one more hack: guard against false values sneaking in.
          input.value = !gamePrefs[key] ? '' : gamePrefs[key];
        } else if (input.type === 'range') {
          // volume: nevermind boolean - convert back from model to form input.
          input.value = gamePrefs[key] * 10;
        } else {
          // NOTE: intentional non-strict comparison here, string vs. int.
          // ALSO important: `checked` needs very much to be a boolean, or else all hell breaks loose.
          input.checked = !!(input.value == value);
        }
      });
    });

    // which battle should the user be playing?
    // hackish: ensure caps, e.g,. tutorial -> Tutorial for form value match
    let lastBattle =
      gamePrefs.last_battle === 'null'
        ? 'tutorial'
        : gamePrefs.last_battle || 'tutorial';

    if (lastBattle) {
      lastBattle = `${lastBattle.charAt(0).toUpperCase()}${lastBattle.substring(1)}`;
      let radio = document.querySelector(
        `#prefs-select-level input[value="${lastBattle}"]`
      );
      if (radio) {
        radio.checked = true;
      }
    }

    // ensure battle list shows the right things.
    updateBattleLists();

    dom.oGameSpeedSlider.value = gamePrefs.game_speed;
    renderGameSpeedSlider();
  }

  function updateGamepadList() {
    // "scan" and list gamepad status.
    let gamepads = gamepad.scanGamepads();
    let info = gamepads.map((gp) => {
      return (
        '&bull; ' +
        (gp.supported ? '✅' : '❌') +
        ' ' +
        gp.prettyLabel +
        ' ' +
        (gp.isStandard
          ? '(Standard)'
          : gp.supported
            ? '(Non-standard, mapping known)'
            : '(Non-standard, mapping unknown)')
      );
    });
    document.getElementById('gamepad-list').innerHTML = info.length
      ? info.join('<br />')
      : 'No gamepads detected. Connect one and press buttons to test.';
  }

  function boolToInt(value) {
    // gamePrefs uses true / false, but the form needs 1 / 0.
    if (typeof value === 'boolean') return value ? 1 : 0;

    return value;
  }

  function stringToBool(value) {
    // LocalStorage stores strings, but JS state uses booleans and numbers.

    // number?
    if (!isNaN(value)) return parseInt(value, 10);

    // string to boolean?
    if (value === 'true') return true;
    if (value === 'false') return false;

    // string
    return value;
  }

  function writePrefsToStorage() {
    // don't do this in the network game case, if we are the guest.
    // we'll inherit prefs from the host, and don't want ours to get clobbered.
    if (net.active && net.isGuest) {
      console.warn(
        'writePrefsToStorage(): NOT storing because we are the guest.'
      );
      return;
    }

    const filteredGamePrefs = {
      ...gamePrefs
    };

    // HACK: don't save tutorial as a game type - preserve current LS value, or default.
    const gt = 'game_type';

    if (filteredGamePrefs[gt] === 'tutorial') {
      const storedType = utils.storage.get(gt);
      filteredGamePrefs[gt] =
        !storedType || storedType === 'tutorial'
          ? defaultPrefs[gt]
          : storedType;
    }

    Object.keys(filteredGamePrefs).forEach((key) =>
      utils.storage.set(key, filteredGamePrefs[key])
    );
  }

  function readPrefsFromStorage() {
    let prefsFromStorage = {};

    // TODO: validate the values pulled from storage. 😅
    Object.keys(defaultPrefs).forEach((key) => {
      let value = utils.storage.get(key);
      // special cases
      if (key === 'volume') {
        prefsFromStorage[key] = value || DEFAULT_VOLUME_MULTIPLIER;
      } else if (key === 'game_speed') {
        // note: default is 1
        prefsFromStorage[key] = value;
      } else if (
        key === 'net_player_name' ||
        key === 'net_remote_player_name'
      ) {
        // guard against "guest" and "host" sneaking into storage
        if (
          prefsFromStorage[key] === 'guest' ||
          prefsFromStorage[key] === 'host'
        )
          prefsFromStorage[key] = '';
      } else if (key === 'webhook_url') {
        // hack: guard against null / false etc.
        value = value || '';
      } else if (value) {
        prefsFromStorage[key] = stringToBool(value);
      }
    });

    // if set, URL prefs override storage
    if (Object.keys(prefsByURL).length) {
      prefsFromStorage = {
        ...prefsFromStorage,
        ...prefsByURL
      };
      applyNewPrefs(prefsFromStorage);
    }

    // ensure prefs are applied on first-time load - so, e.g., it starts snowing right away.
    if (!data.initComplete) {
      const force = true;
      applyNewPrefs(prefsFromStorage, force);
    }

    return prefsFromStorage;
  }

  function readAndApplyPrefsFromStorage() {
    if (!utils.storage.unavailable) {
      let prefs = readPrefsFromStorage();
      applyNewPrefs(prefs);
    }

    updateForm();
  }

  function ignoreURLParams() {
    // edge case: if e.g., #bnb=0 or ?bnb=0 specified, start ignoring once the user clicks and overrides.
    prefsByURL = {};
  }

  function disableNetworkOptions() {
    const rootSelector = '.sync-over-network';

    dom.oForm
      .querySelectorAll(
        `${rootSelector} input:not([data-allow-in-game-updates])`
      )
      .forEach((input) => {
        if (input.type === 'radio' || input.type === 'checkbox')
          input.disabled = true;
      });

    // network-shared / synced menu sections can be "locked down", now that a game is underway.
    // if any were left non-disabled because of the above, then only fade the child nodes.
    dom.oForm.querySelectorAll('.sync-over-network').forEach((node) => {
      // don't "fade" sections that have inputs which are still active.
      utils.css.add(node, 'faded');
      if (node.querySelectorAll('input:not([disabled])').length) {
        // exclude the legend from the fade.
        utils.css.add(node, 'faded-exclude-legend');
      }
    });

    // hide some sections outright, too.
    document
      .querySelectorAll('#network-options-status, #network-options-chat')
      .forEach((node) => (node.style.display = 'none'));
  }

  function resetPlayerNames() {
    // assign defaults

    // the host can keep and re-send its name on re-connect.
    if (!gamePrefs.net_player_name) {
      gamePrefs.net_player_name = net.isHost ? 'host' : 'guest';
    }

    // if/when the remote disconnects, always reset this value.
    gamePrefs.net_remote_player_name = net.isHost ? 'guest' : 'host';
  }

  function resetReadyUI() {
    dom.oFormSubmit.innerHTML = 'OK';
    utils.css.remove(dom.oFormSubmit, 'attention');
  }

  function updateReadyUI() {
    if (game.data.started) {
      updateNetworkStatus(net.connected ? 'Connected' : 'Disconnected');
      return;
    }

    dom.oFormSubmit.innerHTML = data.remoteReadyToStart ? 'START' : 'READY';

    // highlight local button if remote is ready, or reset if not.
    utils.css.addOrRemove(
      dom.oFormSubmit,
      data.remoteReadyToStart,
      'attention'
    );

    let html;
    if (data.remoteReadyToStart) {
      html = 'Ready to start game';
    } else if (data.readyToStart) {
      html = `Waiting for ${
        net.isHost ? 'guest' : 'host'
      }... <span class="mac-system-waiting"></span>`;
    } else {
      // hopefully, still connected.
      html = net.connected ? 'Connected' : 'Disconnected';
    }

    updateNetworkStatus(html);
  }

  function startGame() {
    gameMenu.startGame();

    resetReadyUI();
  }

  function checkGameStart(options = {}) {
    if (data.readyToStart && data.remoteReadyToStart) {
      events.onChat('STARTING GAME...');

      disableNetworkOptions();

      hide();

      // depending on who is ready, delay or not.
      if (options.local) {
        console.log(
          'local is ready; delaying, then starting game',
          net.halfTrip
        );
        window.setTimeout(startGame, net.halfTrip);
      } else {
        console.log('remote ready; starting game immediately');
        startGame();
      }
    } else {
      updateReadyUI();
    }
  }

  function updateGravestones(isActive, pref) {
    const items = game.objects[TYPES.terrainItem];
    let item;
    for (let i = 0, j = items.length; i < j; i++) {
      item = items[i];

      // skip e.g., palm trees that aren't decor for gravestones.
      if (!item.data.gravestoneType) continue;

      // skip if not updating the given type, e.g., gravestones for helicopters.
      if (item.data.gravestoneType !== pref) continue;

      // show or hide, accordingly
      if (isActive && !item.data.summoned) {
        item.summon();
      } else if (!isActive && !item.data.dismissed) {
        item.dismiss();
      }
    }
  }

  data = {
    active: false,
    changelogVisible: false,
    initComplete: false,
    originalHeight: 0,
    network: false,
    lastActiveElement: null,
    lastMenuOpen: 0,
    lastMenuOpenThrottle: 30000,
    readyToStart: false,
    remoteReadyToStart: false,
    bnbVolumeTestSound: null,
    whatsNew: false,
    selectLevel: false
  };

  dom = {
    o: null,
    oBnB: null,
    oChatScroll: null,
    oChatUI: null,
    oForm: null,
    oFormCancel: null,
    oFormScroller: null,
    oFormSubmit: null,
    oGameSpeedSlider: null,
    oNetStatusLabel: null,
    oVolumeSlider: null,
    optionsLink: null,
    oStatsBar: null,
    oGameTips: null,
    oShowChangelog: null,
    oToasts: null
  };

  events = {
    onConnect: () => {
      if (!data.active) return;

      events.onChat('Network connected. Testing ping...');

      updateNetworkStatus('Connected');

      dom.oFormSubmit.disabled = false;
    },

    onDisconnect: () => {
      if (!data.active) return;

      events.onChat('Network connection closed.');

      updateNetworkStatus('Disconnected');

      events.onRemoteReady({ ready: false });

      // reset local state. TODO: preserve and re-send on reconnect?
      events.onReadyState(false);

      resetPlayerNames();
    },

    onNetworkError: (text) => {
      if (!data.active) return;

      events.onChat(`Unable to start network: ${text}`);
      updateNetworkStatus('Error');
    },

    onChat: (text, playerName) => {
      const item = document.createElement('p');

      Object.assign(item.style, {
        margin: '0px',
        padding: '0px'
      });

      // host or guest player name, if specified
      if (playerName !== undefined) {
        text = `<b>${playerName}</b>: ${common.basicEscape(text)}`;
      }

      item.innerHTML = text;

      if (!dom.oChatUI) return;

      dom.oChatUI?.appendChild(item);

      const scroller = dom.oChatScroll;

      const { scrollHeight } = scroller;

      if (scrollHeight) {
        scroller.scrollTop = scrollHeight;
      }
    },

    onUpdatePrefs: (prefs) => {
      if (!prefs?.length) return;

      const isBatch = prefs.length > 1;

      prefs.forEach((pref) => {
        // note, value is boolean.
        let { name, value } = pref;

        // update the local model with the boolean.
        gamePrefs[name] = value;

        // fire local events, as applicable - e.g., game_speed + game_fps.
        events.onPrefChange[name]?.(value);

        // stringify for the form.
        const formValue = boolToInt(value);

        if (dom.oForm) {
          // find all input(s) (radio + checkbox) with the given name, then check the value.
          // qSA() doesn't return a full array, rather a note list; hence, the spread.
          [...dom.oForm.querySelectorAll(`input[name="${name}"]`)].forEach(
            (input) => {
              if (input.type === 'range') {
                input.value = formValue;
                // haaaack: update the local model, too.
                if (input.name === 'game_speed') {
                  common.setGameSpeed(gamePrefs.game_speed);
                  renderGameSpeedSlider();
                }
              } else {
                const match = input.value == formValue;
                input.checked = match;
                // hackish: update the local model, too.
                if (match) {
                  if (name === 'net_game_level') {
                    selectLevel(value);
                  } else if (name === 'net_game_type') {
                    updateBattleLists();
                  }
                }
              }
            }
          );

          // select / option drop-downs.
          [...dom.oForm.querySelectorAll(`select[name="${name}"]`)].forEach(
            (select) => {
              // find the matching entry and set its `selected` property.
              const option = select.querySelector(`option[value="${value}"]`);
              if (option) {
                option.selected = true;
              }
            }
          );
        }

        if (name === 'net_game_style') {
          // re-render, as we may need to show or hide vehicles.
          selectLevel(gamePrefs.net_game_level);
        }

        if (!isBatch) {
          events.onChat(
            `${gamePrefs.net_remote_player_name} changed ${name} to ${formValue}`
          );

          // if we were "ready" to start, we changed our mind - so, reset accordingly.
          events.onReadyState(false);

          if (game.data.started) {
            if (name === 'lock_step') {
              game.objects.notifications.add(
                `${gamePrefs.net_remote_player_name} ${
                  formValue ? 'enabled' : 'disabled'
                } "lock step" game sync.`
              );
              // if disabled, ensure we aren't showing the spinner.
              if (!formValue) {
                game.objects.gameLoop.setWaiting(false);
              }
            } else if (name === 'ground_unit_traffic_control') {
              game.objects.notifications.add(
                `${gamePrefs.net_remote_player_name} ${
                  formValue ? 'enabled' : 'disabled'
                } Ground Vehicle "Traffic Control."`
              );
            }
          }
        }
      });

      if (isBatch) {
        let name = gamePrefs.net_remote_player_name;
        events.onChat(`Received game preferences from ${name}`);
      }
    },

    onRemoteReady: (params) => {
      data.remoteReadyToStart = params.ready;

      // if they're ready and we're ready, then rock and roll; the game can start. 🎸🤘
      checkGameStart({ local: false });
    },

    onReadyState: (newState) => {
      if (game.data.started) return;

      if (!net.connected) {
        dom.oFormSubmit.disabled = true;
      } else {
        dom.oFormSubmit.disabled = newState;
      }

      if (newState === data.readyToStart) return;

      data.readyToStart = newState;

      if (net.connected) {
        net.sendMessage({
          type: 'REMOTE_READY',
          params: { ready: data.readyToStart }
        });
      }

      checkGameStart({ local: true });
    },

    onFormReset: () => {
      if (net.isGuest) {
        // hackish: reload, sans URL parameters because state is corrupted.
        window.location = `//${window.location.host}${window.location.pathname}`;
      } else {
        // reload for host as well, because network has already initialized,
        // the host peerJS state may be unknown and there could be connection trouble.
        window.location.reload();
      }
    },

    onFormSubmit: (e) => {
      // network case
      if (net.connected) {
        // ensure we apply prefs, whether started already or not.
        updatePrefs();

        // if the game is live, just dismiss.
        if (game.data.started) {
          hide();
        } else {
          let text;

          if (!data.remoteReadyToStart) {
            text = `${gamePrefs.net_player_name} is ready to start! Waiting on ${gamePrefs.net_remote_player_name}...`;
          } else {
            text = `${gamePrefs.net_player_name} is ready to start!`;
          }

          events.onChat(text);

          const params = [text];

          net.sendMessage({ type: 'CHAT', params });

          events.onReadyState(true);
        }
      } else {
        updatePrefs();
        writePrefsToStorage();
        hide();
      }

      e?.preventDefault();
      return false;
    },

    optionsLinkOnClick: (e) => {
      show();
      e.preventDefault();
      return false;
    },

    onPrefChange: {
      sound: (isActive) => soundManager?.[isActive ? 'unmute' : 'mute'](),

      bnb: (isActive) => {
        function updateCSS() {
          // numerous UI updates
          utils.css.addOrRemove(document.body, isActive, 'bnb');

          // sprite coords may need updating, if in-game
          [...game.objects.infantry, ...game.objects.engineer].forEach((ie) =>
            ie.refreshHeight()
          );

          // update each turret's "cornholio" object.
          game.objects.turret.forEach((turret) =>
            turret.objects?.cornholio?.setVisible?.(isActive)
          );
        }

        // 600+ sound samples. :P
        if (isActive) {
          initBNBSFX();
        }

        // hackish: un-hide specific DOM elements
        // this is a workaround given "hidden by default" in HTML preventing a FOUC of sorts.
        ['tv-title-screen', 'mtv-bnb-in', 'bnb-vs'].forEach((id) => {
          const o = document.getElementById(id);
          if (o) o.style.visibility = 'visible';
        });

        // first-time activation: preload background images for menu, then activate.
        if (
          !game.data.started &&
          isActive &&
          !utils.css.has(document.body, 'bnb-preload')
        ) {
          // pre-fetch...
          utils.image.preload(
            [
              'bnb/virtual_stupidity_steamgriddb.webp',
              'bnb/virtual_stupidity_overlay.webp',
              'bnb/pngtree.com_color_tv.webp'
            ],
            () => {
              // ...and call this method again, where we'll now pass-thru to the activation.
              events.onPrefChange.bnb(isActive);
            }
          );

          // apply background images via CSS, for pending transition
          utils.css.add(document.body, 'bnb-preload');

          // work is complete for now, just preload.
          return;
        }

        if (isActive) {
          // load CSS first
          aaLoader.loadCSS('aa-bnb.css', updateCSS);
        } else {
          aaLoader.unloadCSS('aa-bnb.css');
          // update immediately
          updateCSS();
        }

        if (!isActive) resetBNBSoundQueue();

        // before game start, user might open options menu and flip the pref.
        // update the game menu (start screen) UI if so.
        if (!game.data.started && data.active) {
          const vsCheckbox = document.getElementById('checkbox-vs');
          if (!vsCheckbox) return;
          vsCheckbox.checked = isActive;
        }

        if (isActive) {
          common.preloadVideo('desert_explosion');
        }
      },

      alt_smart_missiles: (isActive) => {
        if (!isActive) {
          game.objects.view.setMissileMode(defaultMissileMode);
        }

        utils.css.addOrRemove(
          document.body,
          !isActive,
          'original_missile_mode'
        );
      },

      auto_flip: (newAutoFlip) => {
        // only apply to local player if active, and updated
        const { local } = game.players;
        if (!local) return;
        if (local.data.autoFlip !== newAutoFlip) {
          local.toggleAutoFlip();
        }
      },

      game_fps: (newGameFPS) => {
        newGameFPS = parseInt(newGameFPS, 10);
        setFrameRate(newGameFPS);
        net.updateFrameTiming();
        // update helicopter gunfire rate, etc.
        common.applyGameSpeedToAll();
      },

      game_speed: (newGameSpeed) => {
        // slider can go down to 0 (or as converted, false), but ignore those values.
        if (!newGameSpeed) return;
        newGameSpeed = Math.max(GAME_SPEED_MIN, newGameSpeed);
        if (GAME_SPEED === newGameSpeed) return;
        common.setGameSpeed(newGameSpeed);
      },

      gamepad: (newValue) => {
        if (newValue) {
          gamepad.enable();
        } else {
          gamepad.disable();
        }
      },

      gfx_hi_dpi: (newValue) => {
        onPreferHiDPIChange(newValue);
        common?.domCanvas?.onGFXHiDPIChange();
        updateDomFettiContext();
      },

      ground_unit_traffic_control: (isActive) => {
        if (isActive) return;

        // make sure game has started, too.
        if (!game.data.started) return;

        // when "traffic control" is disabled, try and make sure all affected vehicles resume immediately.
        const types = common.pick(
          game.objects,
          TYPES.missileLauncher,
          TYPES.tank,
          TYPES.van
        );

        for (const type in types) {
          types[type].forEach((obj) => {
            // skip over tanks that may be legitimately stopped.
            if (obj.data.lastNearbyTarget) return;
            // otherwise, resume.
            if (obj.data.stopped) obj.data.stopped = false;
          });
        }
      },

      radar_interference_blank: (newBlank) => {
        // flags may not have been applied, e.g., initial game load.
        if (!levelFlags) return;

        // this only applies on battles with jamming / interference flag set.
        if (!levelFlags.jamming) return;

        // radar blur is allowed (as "interference"), if blanking is off.
        utils.css.addOrRemove(
          document.body,
          !newBlank,
          'radar_interference_blur'
        );

        // below here: in-game changes.
        if (!game.data.started) return;

        // if radar is not fully blank, it should have interference.
        if (!newBlank) {
          game.objects.radar.startInterference();
          // hackish / compromise: this may oscillate if there are van(s) in the area, actively blocking.
          game.objects.radar.stopJamming();
        } else {
          game.objects.radar.stopInterference();
          // ensure radar is jammed
          game.objects.radar.startJamming();
        }
      },

      radar_theme: (newTheme) => {
        updateRadarTheme(newTheme);
      },

      weapons_interval_classic: () => {
        game.objects.helicopter?.forEach((chopper) =>
          chopper.updateFiringRates()
        );
      },

      gravestones_helicopters: (isActive, pref) =>
        updateGravestones(isActive, pref),
      gravestones_infantry: (isActive, pref) =>
        updateGravestones(isActive, pref),
      gravestones_vehicles: (isActive, pref) =>
        updateGravestones(isActive, pref),

      // hackish: iterate over radar objects vs. game items, because we may be previewing a level and haven't started a game yet.
      landing_pads_on_radar: (isActive) =>
        game.objects.radar?.objects?.items?.forEach((radarItem) =>
          radarItem?.onHiddenChange?.(isActive)
        ),

      clouds_on_radar: (isActive) =>
        game.objects.radar?.objects?.items?.forEach((radarItem) =>
          radarItem?.onHiddenChange?.(isActive)
        ),

      radar_scaling: (isActive) => {
        if (!game.data.started) return;
        game.objects.radar.enableOrDisableScaling(isActive);
      },

      radar_enhanced_fx: (isActive) => {
        effects.updateNoiseOverlay(isActive);
        utils.css.addOrRemove(document.body, isActive, 'radar_enhanced_fx');
      },

      stars_color: () => {
        game?.objects?.starController?.updateStarColorPref?.();
      },

      stars_density: () => {
        game?.objects?.starController?.updateStarDensityPref?.();
      },

      super_bunker_arrows: (isActive) => {
        game.objects[TYPES.superBunker].forEach((superBunker) =>
          superBunker.onArrowHiddenChange?.(isActive)
        );
      },

      weather: (type) => {
        if (!snowStorm) return;

        if (type && !snowStorm.active) {
          snowStorm.start();
          // hackish: kick off gameLoop, too, which is responsible for animation.
          game.objects.gameLoop.start();
        }

        effects.updateStormStyle(type);

        // update battlefield sprites
        if (game.objects.view) {
          utils.css.addOrRemove(
            game.objects.view.dom.battleField,
            type === 'snow',
            'snow'
          );
        }

        // update canvas images, too.
        [
          TYPES.balloon,
          TYPES.base,
          TYPES.bunker,
          TYPES.endBunker,
          TYPES.superBunker,
          TYPES.terrainItem
        ].forEach((type) => {
          // for now, we only care about snow.
          game.objects[type]?.forEach?.((obj) => obj?.updateSprite?.());
        });
      },

      show_inventory: (show) =>
        utils.css.addOrRemove(dom.oStatsBar, !show, 'hide-inventory'),

      show_weapons_status: (show) =>
        utils.css.addOrRemove(dom.oStatsBar, !show, 'hide-weapons-status'),

      show_keyboard_labels: (show) =>
        utils.css.addOrRemove(dom.oStatsBar, !show, 'hide-keyboard-labels'),

      show_game_tips: (show) => {
        // prevent removal if in tutorial mode, which requires tips
        if (!show && tutorialMode) return;

        utils.css.addOrRemove(dom.oGameTips, show, 'active');
      },

      show_health_status: (newValue) => {
        // hackish: iterate over most objects, and force a redraw of health bars
        let targets = getTypes(
          'tank, van, bunker, missileLauncher, infantry, parachuteInfantry, engineer, helicopter, balloon, smartMissile, endBunker, superBunker, turret',
          { group: 'all' }
        );

        targets.forEach((target) => {
          game.objects[target.type].forEach((obj) => {
            // exit if unset or zero
            if (!obj?.data?.lastEnergy) return;

            // update immediately if pref is now "always" show, OR, "sometimes/never"
            if (newValue === PREFS.SHOW_HEALTH_ALWAYS) {
              sprites.updateEnergy(obj.data.id);
            }
          });
        });
      },

      mobile_controls_location: (newValue) => {
        // given one, remove the other.
        const map = {
          left: 'mobile-controls_left-aligned',
          right: 'mobile-controls_right-aligned'
        };
        if (newValue === 'left') {
          utils.css.swap(document.body, map.right, map.left);
        } else {
          utils.css.swap(document.body, map.left, map.right);
        }
      },

      notifications_location: (newValue) => {
        const map = {
          left: 'left-aligned',
          right: 'right-aligned'
        };
        if (newValue === PREFS.NOTIFICATIONS_LOCATION_LEFT) {
          utils.css.swap(dom.oToasts, map.right, map.left);
        } else {
          utils.css.swap(dom.oToasts, map.left, map.right);
        }
      },

      notifications_order_bottom_up: (newValue) =>
        utils.css.addOrRemove(dom.oToasts, newValue, 'bottom-up'),

      volume: (newValue) => {
        if (!sounds.helicopter?.engine?.sound) return;
        sounds.helicopter.engine.sound.setVolume(
          sounds.helicopter.engineVolume * gamePrefs.volume * newValue
        );
      }
    }
  };

  // DOM event handlers, exposed here for gamepad use.

  events.scrollBy = (offset = 0, node = dom.oFormScroller) => {
    if (!node) return;

    if (!data.layoutCache[node]) {
      data.layoutCache[node] = {
        /**
         * Repurposing for gamepad scroll shenanigans.
         * The distance to be scrolled is the scroll height, minus displayed.
         * This should be invalidated and reset on window and content resize.
         */
        scrollRange: node.scrollHeight - node.offsetHeight
      };
    }

    if (data.layoutCache[node].scrollRange) {
      // move relative to current scroll position, restricting range.
      let newScrollTop = Math.min(
        data.layoutCache[node].scrollRange,
        Math.max(
          node.scrollTop + data.layoutCache[node].scrollRange * offset,
          0
        )
      );
      node.scrollTop = newScrollTop;
    }
  };

  events.fetchWhatsNew = () => {
    const details = document.getElementById('whats-new-content');
    aaLoader.loadHTML('../../NEWS.txt', (response) => {
      details.innerHTML = parseChangelog(response);
    });
  };

  events.fetchChangelog = () => {
    dom.oShowChangelog.setAttribute('disabled', true);
    const details = document.getElementById('changelog-details');

    if (data.changelogVisible) {
      details.innerHTML = '';
      updateChangelog();
      return;
    }
    aaLoader.loadHTML('../../CHANGELOG.txt', (response) => {
      updateChangelog();
      details.innerHTML = '<br />' + parseChangelog(response);
    });
  };

  events.onGameSpeedInput = () => {
    gamePrefs.game_speed = getGameSpeedFromSlider();
    common.setGameSpeed(gamePrefs.game_speed);
    renderGameSpeedSlider();
    queuedSoundHack();
  };

  events.onVolumeChange = () => {
    // randomize, keep it fun.
    data.bnbVolumeTestSound = oneOf(sounds.bnb.volumeTestSounds);
    if (gamePrefs.bnb && !data.didCrankIt) {
      playSound(sounds.bnb.turnItUp, null);
      data.didCrankIt = true;
    }
  };

  events.onVolumeInput = () => {
    // stored in model as 0-1, but form values are 0-10.

    // don't bother doing any SM2 work like mute() etc., just set the "volume scale."
    gamePrefs.volume = getVolumeFromSlider();

    // hackish: apply immediately.
    events.onPrefChange['volume']?.(gamePrefs.volume);

    renderVolumeSlider();

    // play a sound, too.
    playSound(
      gamePrefs.bnb ? data.bnbVolumeTestSound : sounds.inventory.begin,
      null
    );

    queuedSoundHack();
  };

  events.moreInfoHandler = (e) => {
    // expand and collapse a node specified by the clicked element.
    const { target } = e;
    const id = target.getAttribute('data-for');
    const className = 'active';
    const node = document.getElementById(id);
    const showing = !utils.css.has(node, className);
    if (showing) {
      node.style.height = node.scrollHeight + 'px';
    } else {
      node.style.height = '0px';
    }
    utils.css.addOrRemove(node, showing, className);
    e.preventDefault?.();
    return false;
  };

  events.onLevelSelect = (e) => {
    // a level has been selected from within the modal.
    const { value } = e.target;

    // set the preview, etc.
    selectLevel(value);

    gameMenu.updateGameLevelControl(value);
  };

  events.onDifficultySelect = (e) => {
    game.setGameType(e.target.value);
    updateBattleLists();
    gameMenu.updateGameLevelControl();
  };

  events.onInvite = (id) => {
    // TODO: filter URL params, drop ones that are prefs?
    let inviteParams = [`id=${id}&game_style=network`];

    // add existing query params to array, too.
    if (window.location.search.length) {
      inviteParams = inviteParams.concat(
        window.location.search.substring(1).split('&')
      );
    }
    const wl = window.location;
    const inviteURL = `${wl.origin}${wl.pathname}?${inviteParams.join('&')}`;

    utils.copyToClipboard(inviteURL, (ok) => {
      const inviteContainer = document.getElementById(
        'network-options-invite-container'
      );
      inviteContainer?.remove();
      const inviteURLDisplay =
        inviteURL.length > 120 ? inviteURL.slice(0, 120) + '...' : inviteURL;
      const linkDetail = document.getElementById('network-options-link');
      linkDetail.innerHTML = [
        `<p class="non-indented">Send this link to a friend. You are the host, and they will connect to you.</p>`,
        `<a href="${inviteURL}" onclick="return false" class="no-hover" style="font-weight:bold;font-size:75%">${inviteURLDisplay}</a>`,
        ok
          ? `<p class="non-indented">The link has been copied to your clipboard.</p>`
          : ``
      ].join('\n');
      updateNetworkStatus(`Waiting for guest... ☎️ 👀&thinsp;${appleWatch}`);
    });
  };

  /**
   * Special case / slight anti-pattern: assign this before DOM init.
   * This is required because prefsManager needs to init itself,
   * lazy-loading HTML and CSS to display.
   */
  dom.optionsLink = document.getElementById('game-options-link');
  dom.optionsLink.onclick = events.optionsLinkOnClick;

  // notification preferences also may to be applied, left vs. right-alignment before init.
  dom.oToasts = document.getElementById('notification-toasts');

  return {
    addGroupAndLevel,
    applyNewPrefs,
    data,
    events,
    hide,
    init,
    ignoreURLParams,
    isActive,
    onChat: events.onChat,
    onConnect: events.onConnect,
    onDisconnect: events.onDisconnect,
    onNetworkError: events.onNetworkError,
    onRemoteReady: events.onRemoteReady,
    onUpdatePrefs: events.onUpdatePrefs,
    toggleDisplay,
    readPrefsFromStorage,
    readAndApplyPrefsFromStorage,
    setDefaultFocus,
    show,
    updateForm,
    updateGamepadList,
    updateNetworkStatus,
    writePrefsToStorage
  };
}

export { defaultPrefs, gamePrefs, prefs, PREFS, PrefsManager };
