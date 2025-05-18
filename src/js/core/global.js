import { audioSpriteConfig } from '../../config/audioSpriteConfig.js';
import { imageSpriteConfig } from '../../config/imageSpriteConfig.js';
import { soundManager } from '../lib/soundmanager2.js';
import { aaLoader } from './aa-loader.js';

const IMAGE_ROOT = aaLoader.getImageRoot();

// oft-referenced constants, and a few simple methods.

const AUDIO_SPRITE_ROOT = `dist/audio/${audioSpriteConfig.spriteFileName}`;
const SPRITESHEET_URL = `dist/image/${audioSpriteConfig.spriteFileName}.webp${aaLoader.version}`;

const searchParams = new URLSearchParams(window.location.search);

const autoStart = searchParams.get('start');

const DEFAULT_FUNDS = searchParams.get('FUNDS') ? 999 : 32;

const winloc = window.location.href.toString();

const ua = navigator.userAgent;

// You get four choppers, as the original "lives remaining" UI goes down to 0.
const DEFAULT_LIVES = 3;

// how many seconds to show the unit energy UI, on the "sometimes" pref
const ENERGY_TIMER_DELAY = 2;

// timing for fade in/out effects relative to framerate
const ENERGY_TIMER_FADE_RATIO = 0.125;

// defaults, until overridden or set via prefs
let DEFAULT_FPS = 60;
let FPS = DEFAULT_FPS;
let GAME_SPEED_RATIO = FPS === 60 ? 0.5 : 1;
let GAME_SPEED_RATIOED;
let FRAMERATE = 1000 / FPS;

/**
 * You should never do user-agent sniffing, ever...
 * ...except for when you have to, for some very good reason. :X
 */
const isWebkit = ua.match(/webkit/i);

// MS' Edge is likely to include Chrome + 'edg' as an identifier.
const isChrome = !!ua.match(/chrome/i);

const isFirefox = !!ua.match(/firefox/i);
const isSafari = isWebkit && !isChrome && !!ua.match(/safari/i);

// note: macIntel reported even on Apple M2 silicon as of 11/2023.
const isMac = !!ua.match(/mac/i);

// special use, for recording screencasts
const demo = searchParams.get('demo');
const noRadar = searchParams.get('noRadar');

// no notifications, tips etc.
const minimal = searchParams.get('minimal');

/**
 * 11/2023: Experimental iPad hack
 * (tested on "iPad Pro 11-inch 1st-gen" and newer in XCode Simulator)
 * Test for Safari, `TouchEvent`, and `navigator.maxTouchPoints`.
 * Reported issue: iPad Pro wasn't showing mobile controls.
 * iPad defaults to "desktop" UA, but doesn't quite render correctly.
 * iPad treated as "mobile" works much more as expected.
 */
let forceAppleMobile;

if (isSafari) {
  let maybeHasTouch;
  try {
    // may throw "DOMException: Operation is not supported" on non-touch
    document.createEvent('TouchEvent');
    maybeHasTouch = true;
  } catch (e) {
    // oh well
  }
  forceAppleMobile = !!(
    maybeHasTouch &&
    navigator.maxTouchPoints > 0 &&
    !searchParams.get('desktop')
  );
  if (forceAppleMobile) {
    console.log(
      'Safari with touch support detected? Inferring a phone or tablet, rendering mobile version with touch controls.'
    );
    console.log('Try https://play.armor-alley.net/?desktop=1 to override.');
  }
}

/**
 * iOS devices if they report as such, e.g., iPad when
 * "request mobile website" is selected (vs. "request desktop website")
 */
const isMobile = !!ua.match(/mobile|iphone|ipad/i) || forceAppleMobile;

/**
 * iPad may report only macOS, but with touch support
 * that desktops don't have... at time of writing, 05/2025. ;)
 */
let isMaybeiPad =
  (isMac || ua.match(/ipad/i)) &&
  !ua.match(/iphone/i) &&
  navigator?.maxTouchPoints >= 2;

// "inferences" about client capabilities, based on live events
let clientFeatures = {
  touch: forceAppleMobile ? true : null,
  keyboard: null
};

function updateClientFeatures(data) {
  clientFeatures = Object.assign(clientFeatures, data);
}

/**
 * Hackish: global which will update with preferences.
 * This is primarily for utils.js, which tl;dr, can't import prefs.
 */
let preferHiDPI = false;

function onPreferHiDPIChange(newValue) {
  preferHiDPI = newValue;
}

const enemyColors = {
  classic: {
    color: 'rgba(153, 107, 46, 0.9)', // previously: '#9c9f08',
    unit_color: 'rgba(255, 255, 255, 0.75)', // previously: '#ccc',
    color_rgba: 'rgba(204, 204, 204, 0.25)'
  },
  red: {
    color: '#ff3333',
    unit_color: '#ff3333',
    color_rgba: 'rgba(255, 51, 51, 0.25)'
  }
};

const DEFAULT_POINTS = 15;

function float(x, points = DEFAULT_POINTS) {
  // return a number, not a string.
  return +x.toFixed(points);
}

// buildings on radar
let ENEMY_COLOR;

let ENEMY_GUNFIRE_COLOR = '#ccc';
let FRIENDLY_GUNFIRE_COLOR = '#9c9f08';

// units on radar
let ENEMY_UNIT_COLOR;
let ENEMY_UNIT_COLOR_RGBA;

function updateRadarTheme(theme = 'classic') {
  const colors = enemyColors[theme] || enemyColors.classic;
  ENEMY_COLOR = colors.color;
  ENEMY_UNIT_COLOR = colors.unit_color;
  ENEMY_UNIT_COLOR_RGBA = colors.color_rgba;
}

updateRadarTheme();

/**
 * Game Speed - defaults + settings config
 */

const GAME_SPEED_MIN = 0.1;
const GAME_SPEED_DEFAULT_DESKTOP = 1;
const GAME_SPEED_DEFAULT_MOBILE = 0.8;
const GAME_SPEED_MAX = 2;
const GAME_SPEED_INCREMENT = 0.05;
const GAME_SPEED_PARAM = searchParams.get('gameSpeed');

function getDefaultGameSpeed() {
  return isMobile || clientFeatures.touch
    ? GAME_SPEED_DEFAULT_MOBILE
    : GAME_SPEED_DEFAULT_DESKTOP;
}

let GAME_SPEED = getDefaultGameSpeed();

GAME_SPEED_RATIOED = GAME_SPEED * GAME_SPEED_RATIO;

function setFrameRate(fps = DEFAULT_FPS) {
  FPS = fps;
  FRAMERATE = 1000 / FPS;
  GAME_SPEED_RATIO = FPS == 60 ? 0.5 : 1;
  GAME_SPEED_RATIOED = GAME_SPEED * GAME_SPEED_RATIO;
}

function updateGameSpeed(gameSpeed = getDefaultGameSpeed()) {
  gameSpeed = Math.max(
    GAME_SPEED_MIN,
    Math.min(GAME_SPEED_MAX, parseFloat(gameSpeed).toFixed(2))
  );

  if (isNaN(gameSpeed)) {
    // well, something didn't work.
    gameSpeed = getDefaultGameSpeed();
  }

  GAME_SPEED = gameSpeed;

  GAME_SPEED_RATIOED = GAME_SPEED * GAME_SPEED_RATIO;

  return GAME_SPEED;
}

// only assign a value "immediately" if provided via URL.
// otherwise, wait as it may be dependent on device and/or prefs.
if (GAME_SPEED_PARAM) {
  updateGameSpeed(GAME_SPEED_PARAM);
}

// special cases: handling The Notch, etc.
const isiPhone = !!ua.match(/iphone/i);

const debug = searchParams.get('debug');

const debugCollision = searchParams.get('debugCollision');

const DEFAULT_VOLUME = 25;

const rad2Deg = 180 / Math.PI;

// used for various measurements in the game
const worldWidth = 8192;
const worldHeight = 380;
const worldOverflow = 512;

let tutorialMode = !!searchParams.get('tutorial');

function setTutorialMode(state) {
  tutorialMode = state;
}

// classic missile style
const defaultMissileMode = 'default-missile-mode';

// can also be enabled by pressing "C".
const rubberChickenMode = 'rubber-chicken-mode';

// can also be enabled by pressing "B".
const bananaMode = 'banana-mode';

// methods which prefer brevity, vs. being tacked onto `common` or `utils`

/**
 * Type table, supporting both camelCase and dash-type lookups
 * e.g., { parachuteInfantry : 'parachute-infantry' }
 * and { 'parachute-infantry': 'parachute-infantry' }
 * Dash-case is used mostly for DOM / CSS, camelCase for JS
 */
const TYPES = (() => {
  // assign 1:1 key / value strings in a DRY fashion
  const types =
    'aimed-missile, base, bomb, balloon, bunker, chain, cloud, cornholio, engineer, flame, gunfire, helicopter, infantry, end-bunker, landing-pad, missile-launcher, missile-napalm, parachute-infantry, smart-missile, smoke, shrapnel, star, super-bunker, tank, turret, terrain-item, van';
  const result = {};

  types.split(', ').forEach((type) => {
    // { bunker: 'bunker' }
    result[type] = type;

    // dash-case to camelCase
    if (type.indexOf('-') !== -1) {
      // missile-launcher -> ['missile', 'launcher']
      const a = type.split('-');

      // launcher -> Launcher
      a[1] = a[1].charAt(0).toUpperCase() + a[1].slice(1);

      // { missileLauncher: 'missile-launcher' }
      result[a.join('')] = type;
    }
  });

  return result;
})();

const PRETTY_TYPES = {
  [TYPES.tank]: 'Tank',
  [TYPES.missileLauncher]: 'Missile Launcher',
  [TYPES.van]: 'Van',
  [TYPES.infantry]: 'Infantry',
  [TYPES.engineer]: 'Engineer'
};

// set, and updated as applicable via network

let defaultSeeds = [];

for (let i = 0; i < 8; i++) {
  defaultSeeds.push(Math.floor(Math.random() * 0xffffffff));
}

let defaultSeed = defaultSeeds[0];

let seed = Math.floor(defaultSeed);

let seedsByType = {};

// for recording / export purposes
let originalSeedCopy = {
  defaultSeed: null,
  defaultSeeds: null
};

function updateOriginalSeedCopy() {
  originalSeedCopy.defaultSeed = Math.floor(defaultSeed);
  originalSeedCopy.defaultSeeds = structuredClone(defaultSeeds);
}

updateOriginalSeedCopy();

function setSeedsByType() {
  /**
   * TYPES include camelCase entries e.g., missileLauncher,
   * those will be ignored here.
   */
  for (let type in TYPES) {
    if (!type.match(/[A-Z]/)) {
      seedsByType[type] = Math.floor(defaultSeed);
    }
  }
  // special / extra cases
  seedsByType.inventory = Math.floor(defaultSeed);
}

// start with the default, until (and if) updated via network.
setSeedsByType();

function setDefaultSeed(newDefaultSeed, newDefaultSeeds) {
  defaultSeed = newDefaultSeed;
  defaultSeeds = newDefaultSeeds;

  seed = Math.floor(defaultSeed);

  updateOriginalSeedCopy();

  setSeedsByType();
}

// rng: random number *generator*. Tweaked to allow usage of a range of seeds.
// hat tip: https://github.com/mitxela/webrtc-pong/blob/master/pong.htm#L176
function rng(number = 1, type, seedOffset) {
  let t;

  if (type && !seedsByType[type]) {
    console.warn('WTF: no seedsByType for type?', type);
    seedsByType[type] = Math.floor(defaultSeed);
  }

  if (type && seedsByType[type]) {
    t = seedsByType[type] += 0x6d2b79f5;
  } else if (seedOffset >= 0 && defaultSeeds[seedOffset]) {
    t = defaultSeeds[seedOffset] += 0x6d2b79f5;
  } else {
    t = seed += 0x6d2b79f5;
  }

  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

  return number * (((t ^ (t >>> 14)) >>> 0) / 4294967296);
}

function rnd(number) {
  return float(Math.random() * number);
}

function rngBool(type) {
  // roll of the dice.
  return rng(1, type) >= 0.5;
}

function rngInt(number, type) {
  return parseInt(rng(number, type), 10);
}

function rndInt(number) {
  return parseInt(Math.random() * number, 10);
}

function rngPlusMinus(number = 1, type) {
  return float(rng(number, type) >= 0.5 ? number : -number);
}

function plusMinus(number = 1) {
  return float(Math.random() >= 0.5 ? number : -number);
}

function oneOf(array) {
  if (!array?.length) return;
  return array[rndInt(array.length)];
}

function getTypes(typeString, options = { group: 'enemy', exports: null }) {
  /**
   * Used for collision and nearby logic, e.g., ground units that tanks fire at
   * typeString: String to array, e.g., 'tank, van, infantry' mapped to TYPES
   * options{}: group = all, friendly, or enemy - reduced # of object checks.
   */

  if (!typeString?.split) return [];

  let { exports, group } = options;

  // if exports but no group, assume enemy.
  if (!group) {
    group = 'enemy';
  }

  // if NOT looking for all, determine the appropriate group.
  if (group !== 'all') {
    group = determineGroup(group, exports);
  }

  // normalize delimiters, get array.
  return parseTypeString(typeString).map((item) => {
    // "tank:friendly", per-type override
    if (item.indexOf(':') !== -1) {
      const typeAndGroup = item.split(':');
      return {
        type: TYPES[typeAndGroup[0]],
        group: determineGroup(typeAndGroup[1], exports)
      };
    }

    // just "tank", use function signature group
    return { type: TYPES[item], group };
  });
}

function determineGroup(group = 'all', exports) {
  // if the default, no additional work required.
  if (group === 'all') return group;

  if (!exports) {
    console.warn(
      `determineGroup(${group}): missing exports required to determine target`,
      arguments
    );
    return;
  }

  if (exports.data.isEnemy || exports.data.hostile) {
    /**
     * "bad guy" - whatever they're looking for, maps to the opposite array
     * in-game. e.g., enemy tank seeking an enemy = lookups in "friendly"
     * game object array.
     */
    group = enemyGroupMap[group];
  }

  return group;
}

function parseTypeString(typeString) {
  // helper method
  if (!typeString?.replace) return [];

  // 'tank, van, infantry' -> ['tank', 'van', 'infantry']
  return typeString.replace(/[\s|,]+/g, ' ').split(' ');
}

// normalize delimiters -> array; no "group" handling, here.
const parseTypes = (typeString) =>
  parseTypeString(typeString).map((item) => TYPES[item]);

const enemyGroupMap = {
  /**
   * The game stores enemy objects in enemy arrays, and friendly -> friendly.
   * Ergo, when enemies are looking for friendly, they get the enemy array
   * and vice-versa. This is due to legacy names, and could be improved.
   */
  friendly: 'enemy',
  enemy: 'friendly'
};

const COSTS = {
  [TYPES.helicopter]: {
    funds: 20,
    count: 1,
    css: 'can-not-order-helicopter'
  },
  [TYPES.missileLauncher]: {
    funds: 3,
    count: 1,
    css: 'can-not-order-missile-launcher'
  },
  [TYPES.tank]: {
    funds: 4,
    count: 1,
    css: 'can-not-order-tank'
  },
  [TYPES.van]: {
    funds: 2,
    count: 1,
    css: 'can-not-order-van'
  },
  [TYPES.infantry]: {
    funds: 5,
    count: 5,
    css: 'can-not-order-infantry'
  },
  [TYPES.engineer]: {
    funds: 5,
    count: 2,
    css: 'can-not-order-engineer'
  }
};

let gameTypeEmoji = {
  tutorial: '📖',
  easy: '😎',
  hard: '😬',
  extreme: '😰',
  armorgeddon: '😱'
};

export {
  autoStart,
  audioSpriteConfig,
  gameTypeEmoji,
  imageSpriteConfig,
  AUDIO_SPRITE_ROOT,
  DEFAULT_FPS,
  DEFAULT_FUNDS,
  ENEMY_COLOR,
  ENEMY_GUNFIRE_COLOR,
  ENEMY_UNIT_COLOR,
  ENEMY_UNIT_COLOR_RGBA,
  ENERGY_TIMER_DELAY,
  ENERGY_TIMER_FADE_RATIO,
  FRIENDLY_GUNFIRE_COLOR,
  GAME_SPEED,
  GAME_SPEED_DEFAULT_DESKTOP,
  GAME_SPEED_MIN,
  GAME_SPEED_INCREMENT,
  GAME_SPEED_MAX,
  GAME_SPEED_RATIO,
  GAME_SPEED_RATIOED,
  IMAGE_ROOT,
  SPRITESHEET_URL,
  TYPES,
  PRETTY_TYPES,
  COSTS,
  winloc,
  FPS,
  FRAMERATE,
  clientFeatures,
  DEFAULT_LIVES,
  defaultSeed,
  defaultSeeds,
  demo,
  forceAppleMobile,
  getTypes,
  minimal,
  parseTypes,
  isChrome,
  isFirefox,
  isSafari,
  isMobile,
  isiPhone,
  isMac,
  isMaybeiPad,
  debug,
  debugCollision,
  DEFAULT_VOLUME,
  noRadar,
  rad2Deg,
  searchParams,
  worldWidth,
  worldHeight,
  worldOverflow,
  tutorialMode,
  defaultMissileMode,
  rubberChickenMode,
  bananaMode,
  float,
  oneOf,
  preferHiDPI,
  onPreferHiDPIChange,
  originalSeedCopy,
  rnd,
  rng,
  rngBool,
  rndInt,
  rngInt,
  plusMinus,
  rngPlusMinus,
  soundManager,
  setDefaultSeed,
  setFrameRate,
  setTutorialMode,
  updateClientFeatures,
  updateGameSpeed,
  updateRadarTheme
};
