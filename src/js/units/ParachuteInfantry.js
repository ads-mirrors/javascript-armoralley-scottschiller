import { game } from '../core/Game.js';
import { utils } from '../core/utils.js';
import { common } from '../core/common.js';
import {
  worldHeight,
  tutorialMode,
  TYPES,
  rng,
  rngInt,
  GAME_SPEED_RATIOED,
  FPS,
  GAME_SPEED
} from '../core/global.js';
import { skipSound, playSound, sounds } from '../core/sound.js';
import { gamePrefs } from '../UI/preferences.js';
import { sprites } from '../core/sprites.js';
import { effects } from '../core/effects.js';
import { net } from '../core/network.js';

let type = TYPES.parachuteInfantry;

const spriteWidth = 140;
const spriteHeight = 40;

// horizontal sprite arrangement.
const frameWidth = spriteWidth / 5;
const frameHeight = spriteHeight;

const energy = 5;

const ParachuteInfantry = (options = {}) => {
  let exports;

  let data, domCanvas;

  data = common.inheritData(
    {
      type,
      frameCount: rngInt(3, type),
      angle: 0,
      swing: 17.5,
      stepFrames: [],
      stepFrame: 0,
      stepFrameIncrement: 1,
      panicModulus: 3,
      windModulus: options.windModulus || 32 + rngInt(32, type),
      panicFrame: rngInt(3, type),
      energy,
      energyMax: energy,
      parachuteOpen: false,
      // "most of the time", a parachute will open. no idea what the original game did. 10% failure rate.
      parachuteOpensAtY:
        options.parachuteOpensAtY ||
        options.y +
          rng(370 - options.y, type) +
          (!tutorialMode && rng(1, type) > 0.9 ? 999 : 0),
      direction: 0,
      width: 10,
      halfWidth: 5,
      height: 11, // 19 when parachute opens
      halfHeight: 5.5,
      frameHeight: 20, // each sprite frame
      ignoreShrapnel: options.ignoreShrapnel || false,
      didScream: false,
      didHitGround: false,
      landed: false,
      vX: 0, // wind
      vY: options.vY || 2 + rng(1, type),
      maxY: worldHeight + 3,
      maxYPanic: 300,
      maxYParachute: worldHeight - 13
    },
    options
  );

  domCanvas = {
    img: {
      src: utils.image.getImageObject(getSpriteURL(data)),
      source: {
        x: 0,
        y: 0,
        is2X: true,
        width: spriteWidth,
        height: spriteHeight,
        frameWidth,
        frameHeight,
        // sprite offset indices
        // start with "free-falling" state
        frameX: 3,
        frameY: 0
      },
      target: {
        width: spriteWidth / 2,
        height: frameHeight / 2,
        useDataAngle: true
      }
    },
    radarItem: {
      width: 1.25,
      height: 2.5,
      parachuteOpen: {
        width: 2.5,
        height: 2.25
      },
      draw: (ctx, obj, pos, width, height) => {
        const scaledWidth = pos.width(
          data.parachuteOpen ? domCanvas.radarItem.parachuteOpen.width : width
        );
        const scaledHeight = pos.heightNoStroke(
          data.parachuteOpen ? domCanvas.radarItem.parachuteOpen.height : height
        );
        const left = pos.left(obj.data.left) - scaledWidth / 2;
        const top = obj.data.top - scaledHeight / 2;

        ctx.roundRect(left, top, scaledWidth, scaledHeight, [
          scaledHeight,
          scaledHeight,
          0,
          0
        ]);
      }
    }
  };

  exports = {
    animate: () => animate(exports),
    data,
    domCanvas,
    die: (dieOptions) => die(exports, dieOptions),
    hit: () => hit(exports),
    init: () => initParachuteInfantry(exports),
    radarItem: null // assigned later
  };

  // note: duration param.
  makeStepFrames(exports, 1);

  // animation "half-way"
  data.stepFrame = Math.floor(data.stepFrames.length / 2);

  // reverse animation
  if (rng(1, data.type) >= 0.5) {
    data.stepFrameIncrement *= -1;
  }

  return exports;
};

function openParachute(exports) {
  let { data, domCanvas } = exports;

  if (data.parachuteOpen) return;

  // undo manual assignment from free-fall animation
  domCanvas.img.source.frameX = 0;

  // update model with open height
  data.height = 19;
  data.halfHeight = data.height / 2;

  // and parachute speed, too.
  data.vY = 0.3 + rng(0.3, data.type);

  // make the noise
  if (sounds.parachuteOpen) {
    playSound(sounds.parachuteOpen, exports);
  }

  data.parachuteOpen = true;
}

function die(exports, dieOptions = {}) {
  let { data, domCanvas, radarItem } = exports;

  if (data.dead) return;

  domCanvas.img = null;

  if (!dieOptions?.silent) {
    effects.inertGunfireExplosion({ exports });

    if (gamePrefs.bnb) {
      if (data.isEnemy) {
        playSound(sounds.bnb.dvdPrincipalScream, exports);
      } else {
        playSound(sounds.bnb.screamShort, exports);
      }
    } else {
      playSound(sounds.scream, exports);
    }

    common.addGravestone(exports);
  }

  data.energy = 0;

  data.dead = true;

  radarItem?.die(dieOptions);

  common.onDie(data.id, dieOptions);

  sprites.removeNodesAndUnlink(exports);
}

function hit(exports, hitPoints, target) {
  let { data } = exports;

  // special case: helicopter explosion resulting in a paratrooper - make parachute invincible to shrapnel.
  if (target?.data?.type === 'shrapnel' && data.ignoreShrapnel) {
    return false;
  }

  return common.hit(data.id, hitPoints, target.data.id);
}

function animate(exports) {
  let { data, domCanvas } = exports;

  let randomWind, bgX;

  if (data.dead) return data.canDestroy;

  // falling?

  sprites.moveTo(
    exports,
    data.x + data.vX * GAME_SPEED_RATIOED,
    data.y + data.vY * GAME_SPEED_RATIOED
  );

  sprites.draw(exports);

  if (!data.parachuteOpen) {
    if (data.y >= data.parachuteOpensAtY) {
      openParachute(exports);
    } else if (
      data.frameCount >=
      data.panicModulus * (1 / GAME_SPEED_RATIOED)
    ) {
      // like Tom Petty, free fallin'.
      // alternate between 0/1
      data.panicFrame = !data.panicFrame;
      domCanvas.img.source.frameX = 3 + data.panicFrame;
      // recycle
      data.frameCount = 0;
    }
  } else {
    // "range" of rotation
    data.angle = -data.swing + data.swing * 2 * data.stepFrames[data.stepFrame];

    data.stepFrame += data.stepFrameIncrement;

    if (data.stepFrame >= data.stepFrames.length - 1) {
      data.stepFrameIncrement *= -1;
    } else if (data.stepFrame === 0) {
      data.stepFrameIncrement *= -1;
    }

    // (potentially) gone with the wind.
    if (!net.active && data.frameCount % data.windModulus === 0) {
      // choose a random direction?
      if (rng(1, data.type) > 0.5) {
        // -1, 0, 1
        randomWind = rngInt(3, data.type) - 1;

        data.vX = randomWind * 0.5 * GAME_SPEED_RATIOED;

        if (randomWind === -1) {
          // moving left
          bgX = 1;
        } else if (randomWind === 1) {
          // moving right
          bgX = 2;
        } else {
          // not moving!
          bgX = 0;
        }

        domCanvas.img.source.frameX = bgX;
        // choose a new wind modulus, too.
        data.windModulus = 64 + rngInt(64, data.type);
      } else {
        // reset wind effect

        data.vX = 0;

        domCanvas.img.source.frameX = 0;
      }
    }
  }

  if (data.parachuteOpen && data.y >= data.maxYParachute) {
    data.landed = true;

    // touchdown! die "quietly", and transition into new infantry.
    // in the network case, this will kill the remote.
    die(exports, { silent: true });

    const params = {
      x: data.x,
      isEnemy: data.isEnemy,
      // exclude from recycle "refund" / reward case
      unassisted: false,
      // this is an object "conversion", doesn't count against score.
      excludeFromScoreCreate: true
    };

    game.addObject(TYPES.infantry, params);
  } else if (!data.parachuteOpen) {
    if (data.y > data.maxYPanic / 2 && !data.didScream) {
      if (gamePrefs.bnb) {
        if (data.isEnemy) {
          playSound(sounds.bnb.dvdPrincipalScream, exports);
        } else {
          playSound(sounds.bnb.screamPlusSit, exports, {
            onplay: (sound) => {
              // too late if off-screen, parachute open, dead, or landed (in which case, died silently)
              if (
                !data.isOnScreen ||
                data.parachuteOpen ||
                data.landed ||
                data.dead
              ) {
                skipSound(sound);
              }
            }
          });
        }
      } else {
        playSound(sounds.scream, exports);
      }

      data.didScream = true;
    }

    if (data.y >= data.maxY) {
      // hit ground, and no parachute. gravity is a cruel mistress.

      // special case: mark the "occasion."
      data.didHitGround = true;

      // reposition, first
      sprites.moveTo(exports, data.x, data.maxY);

      // balloon-on-skin "splat" sound
      if (sounds.splat) {
        playSound(sounds.splat, exports);
      }

      die(exports);
    }
  }

  data.frameCount++;
}

function getSpriteURL(data) {
  const parts = [];

  // infantry / engineer
  parts.push('parachute-infantry');

  if (data.isEnemy) parts.push('enemy');

  return `${parts.join('-')}.png`;
}

function checkSmartMissileDecoy(exports) {
  // given the current helicopter, find missiles targeting it and possibly distract them.

  game.objects[TYPES.smartMissile].forEach((missile) =>
    missile.maybeTargetDecoy(exports)
  );
}

function initParachuteInfantry(exports) {
  common.initDOM(exports);

  exports.radarItem = game.objects.radar.addItem(exports);

  checkSmartMissileDecoy(exports);
}

function makeStepFrames(exports, duration = 1.75, reverse) {
  let { data } = exports;

  // NOTE: duration parameter added, here.
  duration = FPS * duration * (1 / GAME_SPEED);
  data.stepFrames = [];

  for (let i = 0; i <= duration; i++) {
    // 1/x, up to 1
    data.stepFrames[i] = common.easing.easeInOutSine(i / duration);
  }
  if (reverse) {
    data.stepFrames.reverse();
  }
  data.stepFrame = 0;
  data.stepActive = true;
}

export { ParachuteInfantry };
