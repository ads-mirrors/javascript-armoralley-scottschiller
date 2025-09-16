import { game, getObjectById } from '../core/Game.js';
import { gameType } from '../aa.js';
import { utils } from '../core/utils.js';
import { common } from '../core/common.js';
import { collisionTest } from '../core/logic.js';
import {
  rad2Deg,
  plusMinus,
  rnd,
  rndInt,
  worldHeight,
  TYPES,
  getTypes,
  GAME_SPEED_RATIOED,
  rngInt,
  rngPlusMinus,
  FPS
} from '../core/global.js';
import { playSound, sounds } from '../core/sound.js';
import { sprites } from '../core/sprites.js';
import { effects } from '../core/effects.js';
import { aaLoader } from '../core/aa-loader.js';
import { gamePrefs } from '../UI/preferences.js';

const Bomb = (options = {}) => {
  let exports = {
    options
  };

  exports.data = common.inheritData(
    {
      type: 'bomb',
      parent: options.parent || null,
      parentType: options.parentType || null,
      excludeBlink: true,
      hasHitGround: false,
      hidden: !!options.hidden,
      isFading: false,
      isMuted: false,
      groundCollisionTest: false,
      width: 14,
      height: 6,
      halfWidth: 7,
      halfHeight: 3,
      explosionWidth: 51,
      explosionHeight: 22,
      // fade begins at >= 0.
      fadeFrame: FPS * -0.15,
      fadeFrames: FPS * 0.25,
      hostile: false,
      gravity: 1,
      energy: 3,
      damagePoints: 7,
      damagePointsOnGround: 7,
      napalm: !!options.napalm,
      target: null,
      vX: options.vX || 0,
      vYMax: 128,
      bottomAlign: false,
      angle: 0,
      scale: null,
      shadowColor: null,
      shadowBlur: 0,
      timers: {},
      domFetti: {
        colorType: 'bomb',
        elementCount: 3 + rndInt(3),
        startVelocity: 5 + rndInt(5)
      }
    },
    options
  );

  exports.domCanvas = {
    img: spriteConfig,
    radarItem: {
      width: 1.25,
      height: 2.5,
      draw: (ctx, obj, pos, width, height) => {
        let { data } = exports;
        if (data.isEnemy) {
          ctx.fillStyle = '#cc0000';
        }
        const scaledWidth = pos.width(width);
        const scaledHeight = pos.heightNoStroke(height);
        const left = pos.left(obj.data.left) - scaledWidth / 2;
        const top = obj.data.top;

        common.domCanvas.rotate(
          ctx,
          data.angle + 90,
          left,
          top,
          scaledWidth,
          scaledHeight
        );

        ctx.roundRect(left, top, scaledWidth, scaledHeight, [
          scaledHeight,
          scaledHeight,
          0,
          0
        ]);

        common.domCanvas.unrotate(ctx);
      }
    }
  };

  exports.collision = {
    options: {
      source: exports.data.id,
      targets: undefined,
      checkTweens: true,
      hit(targetID) {
        let { data } = exports;
        let target = getObjectById(targetID);
        // special case: bomb being hit, eventually shot down by gunfire
        if (target.data.type === TYPES.gunfire && data.energy) {
          data.energy = Math.max(0, data.energy - target.data.damagePoints);
          playSound(sounds.metalHit, exports);
          if (!data.hidden) {
            effects.inertGunfireExplosion({ exports, count: 1 + rndInt(2) });
          }
          return;
        }
        bombHitTarget(exports, target);
      }
    },
    // note: "all" parachutes + infantry + engineers can be hit, but friendly collisions happen only when `data.hostile` is true.
    items: getTypes(
      'superBunker, bunker, tank, helicopter, balloon, van, missileLauncher, infantry:all, parachuteInfantry:all, engineer:all, turret, smartMissile',
      { exports }
    ).concat(
      gameType === 'extreme' || gameType === 'armorgeddon'
        ? getTypes('gunfire', { exports })
        : []
    )
  };

  Object.assign(exports, {
    die: (dieOptions = {}) => die(exports, dieOptions),
    dieComplete: () => dieComplete(exports),
    bombHitTarget: (target) => bombHitTarget(exports, target),
    animate: () => animate(exports),
    init: () => initBomb(exports)
  });

  return exports;
};

// static methods which accept and mutate state (exports)

function moveTo(exports, x, y) {
  let { data } = exports;
  let deltaX, deltaY, rad;

  deltaX = 0;
  deltaY = 0;

  if (x !== undefined) {
    deltaX = x - data.x;
  }

  if (y !== undefined) {
    deltaY = y - data.y;
  }

  rad = Math.atan2(deltaY, deltaX);

  if (deltaX || deltaY) {
    data.angle = rad * rad2Deg;
  }

  sprites.moveTo(exports, x, y);
}

function dieExplosion(exports) {
  let { data } = exports;
  exports.domCanvas.dieExplosion = effects.bombExplosion(exports);
  // napalm effect - "flame burns both sides"
  // allow bomb explosion to also hit friendly infantry + engineers.
  data.hostile = true;
}

function spark(exports) {
  exports.domCanvas.img = effects.spark();
  exports.data.isFading = true;
}

function die(exports, dieOptions = {}) {
  let { data, options } = exports;
  // aieee!

  if (data.dead || data.groundCollisionTest) return;

  if (dieOptions.attacker) {
    data.attacker = dieOptions.attacker;
  }

  // possible hit, blowing something up.
  // special case: don't play "generic boom" if we hit a balloon
  if (
    !dieOptions.omitSound &&
    !dieOptions.hidden &&
    sounds.bombExplosion &&
    dieOptions?.type !== TYPES.balloon
  ) {
    playSound(sounds.bombExplosion, exports);
  }

  const isClassicExplosion =
    !dieOptions?.type ||
    (dieOptions.type !== TYPES.bunker && dieOptions.type !== TYPES.superBunker);

  if (dieOptions.spark || !data.napalm) {
    spark(exports);
    // TODO: attach to target?
  } else if (isClassicExplosion) {
    // restore original scale.
    data.scale = 1;
  } else {
    let oAttacker = getObjectById(data?.attacker);
    if (oAttacker?.data?.type !== TYPES.helicopter) {
      // hackish: offset rotation so explosion points upward.
      data.angle -= 90;
      // limit rotation, as well.
      data.angle *= 0.5;
    }
    data.scale = 0.65;
  }

  if (dieOptions.hidden) {
    data.visible = false;
  } else {
    if (!dieOptions.spark && data.napalm) {
      if (isClassicExplosion) {
        dieExplosion(exports);
      } else {
        // "dirt" exposion
        const dirtConfig = (() => {
          let spriteWidth = 1024;
          let spriteHeight = 112;
          let ext = 'png';
          const webP = aaLoader.version || aaLoader.isFloppy;
          // .webp is half-sized via build process, saves some bytes.
          let scale = webP ? 0.5 : 1;
          if (webP) {
            spriteWidth *= scale;
            spriteHeight *= scale;
            ext = 'webp';
          }
          return {
            // overlay: true,
            scale: 0.75 * (1 / scale),
            xOffset: 0,
            yOffset: -30,
            useDataAngle: true,
            sprite: {
              // TODO: refactor this pattern out.
              url: `battlefield/standalone/deviantart-Dirt-Explosion-774442026.${ext}`,
              width: spriteWidth,
              height: spriteHeight,
              frameWidth: spriteWidth / 10,
              frameHeight: spriteHeight,
              animationDuration: 2 / 3,
              horizontal: true,
              hideAtEnd: true
            }
          };
        })();

        data.shadowBlur = 4 * (gamePrefs.gfx_hi_dpi ? 2 : 1);
        data.shadowColor = 'rgba(255, 255, 255, 0.5)';

        exports.domCanvas.dieExplosion = common.domCanvas.canvasAnimation(
          exports,
          dirtConfig
        );
      }
    }
  }

  if (dieOptions.bottomAlign) {
    data.y = 380;

    if (isClassicExplosion) {
      // hack: ensure that angle is 0 for the classic explosion sprite.
      data.angle = 0;
      if (data.napalm) {
        dieExplosion(exports);
      } else {
        // pull spark up slightly
        data.y--;
      }
    }

    // bombs explode, and dimensions change when they hit the ground.
    if (exports.domCanvas.dieExplosion) {
      // pull back by half the difference, remaining "centered" around original bomb coordinates.
      // note that sprite is 2x, so frameWidth is cut in half.
      data.x -=
        (exports.domCanvas.dieExplosion.sprite.frameWidth / 2 - data.width) / 2;

      // resize accordingly
      data.width = exports.domCanvas.dieExplosion.sprite.frameWidth / 2;
      data.halfWidth = data.width / 2;

      // TODO: review data.y vs. data.height in terms of collision logic, if collisions are off.
      data.height = exports.domCanvas.dieExplosion.sprite.frameHeight;
      data.halfHeight = data.height / 2;
    }

    // stop moving
    data.vY = 0;
    data.gravity = 0;

    // this will move the domCanvas stuff, too.
    sprites.moveTo(exports, data.x, data.y);

    // hackish: do one more collision check, since coords have changed, before this element is dead.
    // this will cause another call, which can be ignored.
    if (!data.groundCollisionTest) {
      data.groundCollisionTest = true;
      collisionTest(exports.collision, exports);
    }
  } else {
    // align to whatever we hit

    // hacks: if scaling down, subtract full width.
    // "this is in need of techical review." ;)
    if (data.scale) {
      data.x -= data.width;
    }

    if (dieOptions.type && common.ricochetBoundaries[dieOptions.type]) {
      let halfHeight = dieOptions.attacker?.data?.halfHeight || 3;

      // ensure that the bomb stays at or above the height of its target - e.g., bunker or tank.
      data.y =
        Math.min(
          worldHeight - common.ricochetBoundaries[dieOptions.type],
          data.y
        ) -
        (dieOptions.spark
          ? -(3 + rngInt(halfHeight, data.type))
          : data.height * (data.scale || 1));

      // go there immediately
      moveTo(exports, data.x, data.y);
    } else {
      if (dieOptions.target?.data?.type === TYPES.turret) {
        // special case: align to turret, and randomize a bit.
        const halfWidth = dieOptions.target.data.halfWidth || 3;
        data.x =
          dieOptions.target.data.x +
          halfWidth +
          rngPlusMinus(rngInt(halfWidth, data.type), data.type);
        data.y =
          dieOptions.target.data.y +
          rngInt(dieOptions.target.data.height, data.type);
        dieOptions.extraY = 0;
      }

      // extraY: move bomb spark a few pixels down so it's in the body of the target. applies mostly to tanks.
      moveTo(exports, data.x, data.y + (dieOptions.extraY || 0));
    }

    // "embed", so this object moves relative to the target it hit
    sprites.attachToTarget(exports, dieOptions.target);
  }

  data.timers.deadTimer = common.frameTimeout.set('dieComplete', 1500);

  // TODO: move into something common?
  if (data.isOnScreen) {
    for (let i = 0; i < 3; i++) {
      game.addObject(TYPES.smoke, {
        x: data.x + data.halfWidth,
        y: dieOptions.bottomAlign ? worldHeight - 8 : data.y,
        vX: plusMinus(rnd(3.5)),
        vY: rnd(-2.5),
        spriteFrame: rndInt(5)
      });
    }
  }

  effects.domFetti(data.id, dieOptions.target?.data?.id);

  effects.inertGunfireExplosion({
    exports,
    count: 2 + rndInt(2)
  });

  data.dead = true;

  if (exports.radarItem) {
    exports.radarItem.die({
      silent: true
    });
  }

  common.onDie(data.id, dieOptions);

  if (options.onDie) {
    options.onDie(exports, dieOptions);
  }
}

function dieComplete(exports) {
  // avoid redundant remove/unlink work.
  if (exports?.data?.canDestroy) return;

  exports.domCanvas.dieExplosion = null;
  sprites.removeNodesAndUnlink(exports);
}

function bombHitTarget(exports, target) {
  let { data, options } = exports;

  let spark, bottomAlign, damagePoints, hidden;

  // assume default
  damagePoints = data.damagePoints;

  // some special cases, here

  if (target.data.type === TYPES.smartMissile) {
    die(exports, {
      attacker: target.data.id,
      type: target.data.type,
      omitSound: true,
      spark: true,
      target
    });
  } else if (target.data.type === TYPES.infantry) {
    /**
     * bomb -> infantry special case: don't let bomb die; keep on truckin'.
     * continue to ground, where larger explosion may take out a group of infantry.
     * only do damage once we're on the ground. this means infantry will play the
     * hit / "smack" sound, but don't die + scream until the bomb hits the ground.
     */
    if (!data.hasHitGround) {
      damagePoints = 0;
    }
  } else {
    // certain targets should get a spark vs. a large explosion
    spark = target.data.type?.match(
      /tank|parachute-infantry|turret|smart-missile|gunfire/i
    );

    // hide bomb sprite entirely on collision with these items...
    hidden = data.hidden || target.data.type.match(/balloon/i);

    bottomAlign =
      (!spark &&
        !hidden &&
        target.data.type !== TYPES.helicopter &&
        target.data.type !== TYPES.superBunker &&
        target.data.type !== TYPES.balloon &&
        target.data.type !== TYPES.gunfire &&
        target.data.type !== TYPES.bunker) ||
      target.data.type === TYPES.infantry;

    data.bottomAlign = bottomAlign;

    die(exports, {
      attacker: target.data.id,
      type: target.data.type,
      spark,
      hidden,
      bottomAlign,
      // and a few extra pixels down, for tanks (visual correction vs. boxy collision math)
      extraY: target.data.type?.match(/tank/i) ? 3 + rngInt(3, data.type) : 0,
      target
    });
  }

  // if specified, take exact damage.
  if (options.damagePoints) {
    damagePoints = options.damagePoints;
  } else if (target.data.type) {
    // special cases for bomb -> target interactions

    if (target.data.type === TYPES.helicopter) {
      // one bomb kills a helicopter.
      damagePoints = target.data.energyMax;
    } else if (target.data.type === TYPES.turret) {
      // bombs do more damage on turrets if a direct hit; less, if from a nearby explosion.
      damagePoints = data.hasHitGround ? 3 : 10;
    } else if (data.hasHitGround) {
      // no specific target match: take 33% cut on bomb damage
      damagePoints = data.damagePointsOnGround;
    }

    // bonus "hit" sounds for certain targets
    if (!data.isMuted) {
      if (
        target.data.type === TYPES.tank ||
        target.data.type === TYPES.turret
      ) {
        playSound(sounds.metalHit, exports);
      } else if (target.data.type === TYPES.bunker) {
        playSound(sounds.concreteHit, exports);
        data.isMuted = true;
      } else if (
        target.data.type === TYPES.bomb ||
        target.data.type === TYPES.gunfire
      ) {
        playSound(sounds.ricochet, exports);
      } else if (
        target.data.type === TYPES.van ||
        target.data.type === TYPES.missileLauncher
      ) {
        playSound(sounds.metalHit, exports);
        playSound(sounds.metalClang, exports);
        data.isMuted = true;
      }
    }
  }

  common.hit(target.data.id, damagePoints, data.id);
}

function animate(exports) {
  let { data } = exports;
  exports.domCanvas?.dieExplosion?.animate();

  if (data.dead) {
    // may be attached to a target, and/or fading out.
    sprites.movePendingDie(exports);

    return !data.timers.deadTimer && data.canDestroy;
  }

  data.gravity *= 1 + 0.1 * GAME_SPEED_RATIOED;

  moveTo(
    exports,
    data.x + data.vX * GAME_SPEED_RATIOED,
    data.y +
      Math.min(
        data.vY * GAME_SPEED_RATIOED + data.gravity * GAME_SPEED_RATIOED,
        data.vYMax
      )
  );

  // hit bottom?
  if (data.y > game.objects.view.data.battleField.height) {
    data.hasHitGround = true;
    die(exports, {
      hidden: data.hidden,
      bottomAlign: true
    });
  }

  collisionTest(exports.collision, exports);

  sprites.draw(exports);

  // notify caller if dead, and node has been removed.
  return data.dead && !data.timers.deadTimer && !dom.o;
}

function initBomb(exports) {
  let { data } = exports;

  if (data.hidden) return;

  // TODO: don't create radar items for bombs from enemy helicopter when cloaked
  exports.radarItem = game.objects.radar.addItem(exports);
}

const spriteConfig = (() => {
  const spriteWidth = 26;
  const spriteHeight = 10;
  return {
    src: utils.image.getImageObject('bomb.png'),
    source: {
      x: 0,
      y: 0,
      width: spriteWidth,
      height: spriteHeight,
      is2X: true,
      frameWidth: spriteWidth,
      frameHeight: spriteHeight,
      frameX: 0,
      frameY: 0
    },
    target: {
      width: spriteWidth / 2,
      height: spriteHeight / 2,
      useDataAngle: true
    }
  };
})();

export { Bomb };
