/**
 * Helicopter "AI"
 * Rudimentary, dumb smarts using vectors and basic steering behaviours.
 * As with prior versions in the 2010s: To call this "AI" would be an insult to the AI community. ;)
 * Rule-based logic: Detect, target and destroy enemy targets, hide in clouds, return to base as needed and so forth.
 */

import { FPS, rngBool, rngInt, tutorialMode, TYPES } from '../core/global.js';
import {
  collisionCheckX,
  isFacingTarget,
  objectInView,
  objectsInView
} from '../core/logic.js';
import { utils } from '../core/utils.js';
import { getAverages, Vector } from '../core/Vector.js';
import {
  avoidBuildings,
  avoidNearbyMunition,
  avoidAboveOrBelow
} from './Helicopter-avoid.js';
import { brakeX, distance, findEnemy } from './Helicopter-utils.js';
import { applyForces } from './Helicopter-forces.js';
import {
  checkVerticalRange,
  seekEndBunker,
  seekLandingPad,
  seekTarget,
  steerTowardTarget
} from './Helicopter-steering.js';
import { resetSineWave, wander } from './Helicopter-wander.js';
import { levelConfig, levelFlags, levelNumber } from '../levels/default.js';
import { net } from '../core/network.js';
import { common } from '../core/common.js';
import { gameType } from '../aa.js';
import { game, getObjectById } from '../core/Game.js';
import { TURRET_SCAN_RADIUS } from '../buildings/Turret.js';

// low fuel means low fuel. or ammo. or bombs.
let lowFuelLimit = 30;
let lowEnergyLimit = 2;

const turretLookAhead = 128;

const retaliationModeDuration = 30000;

const HelicopterAI = (options = {}) => {
  const { data } = options.exports;

  data.sineWaveTimer = null;
  data.sineFrameOffset = 0;
  data.sineWaveMin = 128;

  data.averages = getAverages();

  let target;
  let tData;

  let lastTarget;

  // "AI-assigned" opposing helicopter targeting
  let missileTarget;
  let missileLaunchTimer;

  // throttle how often the helicopter can decide to chase when hit by e.g., gunfire
  let respondToHitTimer;
  let respondToHitDelay = 1000;

  // at which point the chopper can retaliate
  let missileEnergyThreshold =
    gameType === 'extreme' ? 8 : gameType === 'hard' ? 5 : 2;

  // retaliate with a single missile, unless in extreme (armorgeddon) mode
  let oneMissileOnly = gameType !== 'extreme';

  // throttle how often paratroopers can be dropped over target(s)
  let paratrooperDropTimer;
  let paratrooperDropDelay = 30000;

  let parachutingActiveTimer;

  data.vectors = {
    acceleration: new Vector(0, 0),
    seek: null,
    arrive: null,
    avoid: null
  };

  data.forces = {
    /*
      avoid: { 'balloon': [], 'gunfire': [], 'default': [] }
      seek: {}
      arrive: {}
    */
  };

  // similar to forces
  data.actions = {};

  function resetForces() {
    data.forces = {};
  }

  function resetActions() {
    data.actions = {};
  }

  function throttleVelocity() {
    // when retaliation is engaged, full-speed is allowed even if level specifies VX clipping.
    // NOTE: max is 50% for CPU in any case, otherwise the CPU flies twice as fast between regular + "AI" movement.
    let max =
      (data.useClippedSpeed && !data.targeting.retaliation
        ? data.vXMaxClipped
        : data.vXMax) / 2;
    data.vX = Math.max(-max, Math.min(max, data.vX));
    data.vY = Math.max(-max, Math.min(max, data.vY));
  }

  // "threats" which can be fired at
  let threatTypes = [TYPES.parachuteInfantry];

  // ability to fire at incoming smart missiles
  let threatTypesWithMissile = threatTypes.concat(TYPES.smartMissile);

  function ai() {
    // ignore if dead
    if (data.dead) return;

    // wait until fully-respawned, including initial undefined / not-yet-initialized case.
    if (data.respawning || data.respawning === undefined) return;

    // ignore if on empty.
    if (data.fuel <= 0) return;

    // reset counts
    data.votes.ammo = 0;
    data.votes.bomb = 0;

    // TODO: ridiculous - refactor.
    data.ammoTargets = [];
    data.bombTargets = [];

    data.avoidingTurret = false;
    data.foundSteerTarget = false;
    data.wantsLandingPad = false;

    target = null;
    tData = null;

    data.vectors.acceleration = new Vector();

    data.didWander = false;

    // reset every frame, may be applied if chasing helicopter etc.
    data.useClippedSpeed = false;

    // go for the landing pad?
    landingPadCheck();

    // new target(s)?
    checkLastAndNewTarget();

    // high priority: avoid obstacles.
    let foundBuilding = avoidBuildings(data);
    let foundAboveOrBelow = avoidAboveOrBelow(tData, data);

    if (!foundBuilding || foundAboveOrBelow) {
      // if "safe," go for target.
      maybeSteerTowardTarget(tData, data);

      // dodge bullets, etc., if also no obstacle.
      avoidNearbyMunition(data);
    }

    // incoming gunfire etc.
    checkThreats();

    // offensive
    maybeFireOrBomb(data, options);

    // motion
    wander(data);

    checkVerticalRange(data);

    applyForces(data);
    throttleVelocity();
    resetForces();
    resetActions();
  }

  function landingPadCheck() {
    // low fuel means low fuel. or ammo. or bombs.
    let needsFuel = data.fuel < data.needsFuel;

    // short on bullets, OR completely out of aimed / dumb missiles
    let needsAmmo = levelFlags.bullets ? data.ammo < 6 : !data.ammo;

    let needsBombs = !data.bombs;
    let needsRepair = data.energy < 5;

    // sneaky: adding booleans, comparing integers.
    // note: chopper more likely to return for repair on first two battles.
    let needsRefit =
      needsFuel ||
      needsAmmo +
        needsBombs +
        needsRepair +
        (levelNumber === 1 || levelNumber === 2) >=
        2;

    if (needsRefit && !data.landed && !data.repairing) {
      seekLandingPad(data, options);
      return;
    }

    // TODO: this could be used if the human chopper is nearby and a threat, etc.
    // let combatReady = data.fuel > (data.maxFuel * 0.3) && data.bombs > 2 && data.energy > 10;
    if (
      data.onLandingPad &&
      (data.repairing || !data.repairComplete) &&
      (data.vX !== 0 || data.vY !== 0)
    ) {
      data.vX = 0;
      data.vY = 0;
    }
  }

  function checkLastAndNewTarget() {
    // ignore all of this while still on the landing pad.
    if (data.landed) return;

    if (lastTarget) {
      // did current or recent target become invalidated, or (TODO) unreachable?
      let ltData = lastTarget?.data;

      if (ltData.dead || ltData.cloaked) {
        // toast, or hiding
        lastTarget = null;
      }

      // if targeting tanks, but no bombs, then forget this one.
      if (ltData === TYPES.tank && !data.bombs) {
        lastTarget = null;
      }
    }

    let newTarget;

    if (!data.wantsLandingPad) {
      maybeTakeOutEndBunker();

      // priority: own end bunker has been captured.
      if (maybeRecaptureEndBunker()) return;

      if (!newTarget && data.targeting.helicopters) {
        newTarget = objectInView(data, { items: TYPES.helicopter });
      }

      // TODO: gunfire, dumb missiles, and maybe smart missiles for targeting.
      if (data.targeting.tanks && data.bombs && levelConfig.scatterBombB) {
        newTarget = objectInView(data, { items: TYPES.tank });
      }

      if (!newTarget && data.targeting.bunkers) {
        newTarget = objectInView(data, { items: TYPES.bunker });
      }

      if (!newTarget && data.targeting.superBunkers) {
        newTarget = objectInView(data, { items: TYPES.superBunker });
      }

      if (!newTarget && data.targeting.clouds) {
        newTarget = objectInView(data, { items: TYPES.cloud });
      }

      if (newTarget) {
        lastTarget = target;
        target = getObjectById(newTarget);
        tData = target?.data;
      } else if (levelFlags.bullets && data.ammo) {
        // fallback: try for balloons, if we have bullets and not "aimed" missiles.
        newTarget = findEnemy(data, TYPES.balloon);
        if (newTarget.length) {
          target = getObjectById(newTarget[0]);
          tData = target.data;
        }
      }
    }

    if (tData) {
      if (
        (data.targeting.bunkers && tData.type === TYPES.bunker) ||
        (data.targeting.superBunkers && tData.type === TYPES.superBunker)
      ) {
        maybeDropParatroopersNearTarget(target);
      } else if (tData.type !== TYPES.cloud) {
        maybeFireAtTarget(target);
        maybeBombTarget(target);
      }
    }

    /**
     * Be up for bombing opposing choppers, in attack mode.
     * Also, consider launching "dumb" aimed missiles if armed accordingly.
     */

    if (data.targeting.attackB) {
      for (var i = 0, j = game.objects.helicopter.length; i < j; i++) {
        if (
          game.objects.helicopter[i].data.isEnemy !== data.isEnemy &&
          game.objects.helicopter[i] !== target
        ) {
          maybeBombTarget(game.objects.helicopter[i]);
          // additional special case: aimed missiles.
          if (!levelFlags.bullets || levelConfig.killCopterB) {
            maybeFireAtTarget(game.objects.helicopter[i]);
          }
        }
      }
    }

    if (data.targeting.men && data.bombs) {
      let nearbyMan = getObjectById(
        objectInView(data, {
          items: [TYPES.infantry, TYPES.engineer],
          triggerDistance: data.width * 2
        })
      );

      if (nearbyMan) {
        maybeBombTarget(nearbyMan);
      }
    }

    if (data.targeting.vans && data.bombs) {
      let nearbyVan = getObjectById(
        objectInView(data, {
          items: TYPES.van,
          triggerDistance: data.width * 2
        })
      );

      if (nearbyVan) {
        maybeBombTarget(nearbyVan);
      }
    }

    // maybe bomb turrets, too?
    if (data.targeting.turrets || data.cloaked) {
      // scan for turrets, before entering their firing range
      let nearbyTurret = getObjectById(
        objectInView(data, {
          items: TYPES.turret,
          triggerDistance: TURRET_SCAN_RADIUS * 1.5
        })
      );

      if (nearbyTurret) {
        maybeBombTarget(nearbyTurret);

        maybeDropParatroopersNearTarget(nearbyTurret);

        let checkBombs = true;
        maybeFireSmartMissileAtTurret(checkBombs);
      }
    }
  }

  function maybeFireSmartMissileAtTurret(checkBombs) {
    // extra-mean: maybe fire and/or launch a smart missile, if not going after the chopper.
    if (missileLaunchTimer) return;
    if (tData?.type === TYPES.helicopter) return;

    let mTarget = getObjectById(objectInView(data, { items: TYPES.turret }));

    if (!mTarget) return;

    // possibly redundant
    maybeFireAtTarget(mTarget);

    // only throw in a smart missile if allowed.
    if (!levelConfig.useMissileB) return;

    // conservative option: bomb check.
    // this can be ignored when e.g., retaliating to turret gunfire.
    if (checkBombs && levelConfig.scatterBombB && data.bombs >= 5) return;

    if (!collisionCheckX(mTarget.data, data, turretLookAhead)) return;

    // wait a few frames before firing.
    let delay = rngInt(FPS * 5, data.type);

    missileLaunchTimer = common.setFrameTimeout(() => {
      // sanity check, given delay / async...
      if (data.dead || mTarget.data.dead) {
        missileLaunchTimer = null;
        return;
      }

      // "AI" target for helicopter missile launch method
      // (predetermined rather than real-time, because reasons.)
      missileTarget = mTarget.data.id;

      // it's possible the CPU is being chased, needs to flip to fire.
      options.exports.checkFacingTarget(mTarget);

      options.exports.setMissileLaunching(true);

      // and, stop momentarily.
      common.setFrameTimeout(
        () => {
          options.exports.setMissileLaunching(false);
          missileLaunchTimer = null;
          // if on "easy", only one missile.
          // otherwise, up to two.
        },
        gameType === 'easy' ? 1 / FPS : FPS
      );
    }, delay);
  }

  function checkThreats() {
    /**
     * Identify incoming / nearby things to fire at, but not chase.
     * NOTE: only fire at things the chopper is facing - no backwards firing tricks.
     */

    // allow missiles to be shot at, IF enabled in level config, we have bullets, and enough of 'em
    let types =
      levelConfig.killMissileB && levelFlags.bullets && data.ammo > 5
        ? threatTypesWithMissile
        : threatTypes;

    let nearbyThreats = findEnemy(data, types, 192);

    let threat = getObjectById(nearbyThreats[0]);

    if (!threat) return;

    // if a smart missile is found, the chopper can target and fire at it IF in "defend" mode.
    if (threat.data.type === TYPES.smartMissile && !data.targeting.defendB)
      return;

    // ensure the target has *some* room, not almost directly above or below,
    // and roughly within vertical.
    if (
      threat &&
      isFacingTarget(threat.data, data) &&
      distance(threat.data.x, data.x) >= data.width &&
      distance(threat.data.y, data.y) <= data.height * 1.5
    ) {
      data.votes.ammo++;
      data.ammoTargets.push(threat.data);
    }
  }

  function maybeRecaptureEndBunker() {
    /**
     * If the pesky human has captured the CPU end bunker, try to recover.
     * Otherwise, enemy production will be stopped for quite a long time.
     */

    // firstly, need paratroopers.
    if (!data.parachutes) return;

    // only do this while in "attack" AND "defend" mode.
    if (!data.targeting.defendB || !data.targeting.attackB) return;

    let endBunker = game.objects[TYPES.endBunker][data.isEnemy ? 1 : 0];

    // end bunker needs to be "dead", AND, -ve funds due to capture
    if (endBunker.data.energy || endBunker.data.funds >= 0) return;

    // use van jamming range as a maximum for "detecting" end bunker trouble.
    if (distance(endBunker.data.x, data.x) > levelConfig.vanJammingI) return;

    steerTowardTarget(
      data,
      endBunker.data,
      // inverse offset to the other side of the bunker, respectively
      endBunker.data.width * endBunker.data.isEnemy ? -1 : 1,
      // ignore target Y and go specifically to this coordinate...
      false,
      120
    );

    maybeDropParatroopersNearTarget(endBunker);

    // indicate to caller: yes, this is priority.
    return true;
  }

  function maybeDecoySmartMissile(missile) {
    /**
     * If airborne and targeted by a newly-minted smart missile,
     * (maybe) drop a decoy paratrooper.
     */

    // only do this while in "defend" mode.
    if (!data.targeting.defendB) return;

    // if missile is from a helicopter, maybe retaliate.
    if (missile && missile.data.parentType === TYPES.helicopter) {
      maybeEngageRetaliationMode();
    }

    // nothing to drop?
    if (!data.parachutes) return;

    // don't implement in network games until tested and stable.
    if (net.active) return;

    // "reasonably" airborne, time for parachute to open etc.?
    if (data.landed || data.y > 300) return;

    // 50% chance...
    if (!rngBool(TYPES.helicopter)) return;

    // finally, deploy
    dropParatroopersAtRandom();
  }

  function dropAllParatroopersAtRandom(startDelayMax = 500) {
    /**
     * Deploy all available paratroopers, using a random delay for starting.
     */
    if (parachutingActiveTimer || !data.parachutes) return;

    let startDelay = rngInt(startDelayMax, TYPES.helicopter);
    let stopDelay = 1000;

    parachutingActiveTimer = common.setFrameTimeout(() => {
      options.exports.setParachuting(true);
      // and, stop dropping momentarily.
      common.setFrameTimeout(() => {
        options.exports.setParachuting(false);
        parachutingActiveTimer = null;
      }, stopDelay);
    }, startDelay);
  }

  function dropParatroopersAtRandom(
    startDelay = rngInt(1000, TYPES.helicopter),
    minimalDelay
  ) {
    /**
     * Deploy a random number of paratroopers, using a random delay basis for both start and duration.
     * This means the chopper can be late to act (e.g., decoy a smart missile), AND/OR, it may drop multiple paratroopers.
     */
    if (parachutingActiveTimer || !data.parachutes) return;

    parachutingActiveTimer = common.setFrameTimeout(() => {
      options.exports.setParachuting(true);

      let stopDelay = minimalDelay ? 1 / FPS : startDelay / 2;

      // and, stop dropping momentarily.
      common.setFrameTimeout(() => {
        options.exports.setParachuting(false);
        parachutingActiveTimer = null;
      }, stopDelay);
    }, startDelay);
  }

  function maybeSteerTowardTarget(tData, data) {
    if (!tData) return;
    // TODO: refactor CPU "can target" logic for other applicable objects
    let isStructure =
      tData.type === TYPES.bunker ||
      tData.type === TYPES.superBunker ||
      tData.type === TYPES.endBunker ||
      tData.type === TYPES.turret;
    if (
      !data.foundSteerTarget &&
      !data.wantsLandingPad &&
      // don't go explicitly after balloons.
      tData.type !== TYPES.balloon &&
      !isStructure &&
      // don't try to go after landed helicopters.
      !tData.landed
    ) {
      // go for it!
      data.foundSteerTarget = true;
      // clip speed? this may be the only case where speed throttling applies.
      if (tData.type === TYPES.helicopter) {
        data.useClippedSpeed = true;
      }

      /**
       * Special case: "all criteria met" for a kamikaze run.
       * Targeting helicopters (and one nearby), provoked (retaliation), level flag set, empty munitions.
       */
      if (
        levelConfig.suicideB &&
        tData.type === TYPES.helicopter &&
        data.targeting.helicopters &&
        tData.type === TYPES.helicopter &&
        data.targeting.retaliation &&
        !data.ammo &&
        !data.bombs &&
        !data.smartMissiles
      ) {
        data.isKamikaze = true;
      } else {
        data.isKamikaze = false;
      }

      if (data.isKamikaze) {
        let seekMag = 1;
        seekTarget(
          data,
          {
            x: tData.x,
            y: tData.y,
            type: tData.type
          },
          seekMag
        );
      } else {
        // TODO: review offset logic.
        steerTowardTarget(
          data,
          tData,
          tData.type === TYPES.cloud ? -1 : data.halfWidth
        );
      }
    }
  }

  function maybeBombTarget(target) {
    /**
     * WITHIN BOMBING RANGE
     */

    // does this battle allow bombing?
    if (!levelConfig.scatterBombB) return;

    // and, do we have bombs to drop?
    if (!data.bombs) return;

    const targetData = target?.data;
    if (!targetData || targetData.dead || targetData.cloaked) return;

    if (collisionCheckX(targetData, data) && data.y < targetData.y) {
      // align on X-axis, player / balloon / tank / turret is below

      // Sanity check: avoid hitting friendly men with napalm-enabled bombs, as flame burns both sides.
      if (levelFlags.bNapalm) {
        let friendsInView = objectsInView(data, {
          items: [TYPES.infantry, TYPES.engineer],
          triggerDistance: 128,
          friendlyOnly: true
        });

        if (friendsInView.length) return;
      }

      // drop ze bombs!
      brakeX(data, 0.98);
      data.votes.bomb++;
      data.bombTargets.push(targetData);
    }
  }

  const bombsByTarget = {};

  function getBombTargetID(target) {
    if (!target?.data) return '';
    /**
     * Infantry + engineers: limit by "group of men" vs. per-object IF we have napalm, since these come in groups.
     * This avoids redundant carpet-bombing of five unique objects, e.g., default group of five infantry.
     */
    let id =
      (target.data.type === TYPES.infantry ||
        target.data.type === TYPES.engineer) &&
      levelConfig.bNapalm
        ? 'men'
        : target.data.id;

    return id;
  }

  function canBombTarget(target) {
    /**
     * Basic bomb -> target throttling: limit to one bomb for most targets.
     * Tanks get up to 3; turrets can be carpet-bombed at will.
     */

    if (!target?.data) return;

    // unlimited bombs
    if (target.data.type === TYPES.turret) return true;

    let id = getBombTargetID(target);

    if (!bombsByTarget[id]) {
      bombsByTarget[id] = {
        bombCount: 0,
        bombLimit:
          target.data.type === TYPES.tank ||
          target.data.type === TYPES.helicopter
            ? 3
            : 1,
        timer: null
      };
    }

    let bbt = bombsByTarget[id];

    // at capacity?
    if (bbt.bombCount >= bbt.bombLimit) return;

    // bombs away!
    return true;
  }

  function addBomb(target) {
    let data = bombsByTarget[getBombTargetID(target)];
    if (!data) return;
    data.bombCount++;
    // cancel any pending clear timer if this object is being re-used -
    // e.g., a new group of `men` after one was killed off.
    if (data.timer) {
      data.timer.reset();
      data.timer = null;
    }
  }

  function removeBomb(target) {
    let id = getBombTargetID(target);
    let data = bombsByTarget[id];
    if (!data) return;
    data.bombCount = Math.max(0, data.bombCount - 1);
    if (!data.bombCount) {
      delete bombsByTarget[id];
    }
  }

  function clearBombWithDelay(target, delay = 2500) {
    let id = getBombTargetID(target);
    let data = bombsByTarget[id];
    if (!data) return;
    if (data.timer) return;
    data.timer = common.setFrameTimeout(() => delete bombsByTarget[id], delay);
  }

  function maybeFireAtTarget(target) {
    /**
     * WITHIN FIRING RANGE
     */
    const targetData = target?.data;
    if (!targetData) return;

    let dY = distance(targetData.y, data.y);

    // firstly, ignore if not close on Y-axis.
    if (dY > data.height * 1.5) return;

    let isHelicopter = targetData.type === TYPES.helicopter;
    let dX = distance(targetData.x, data.x);
    if (
      // ignore if too far away, OR basically right above / underneath.
      dX < 320 &&
      dX > data.width
    ) {
      /**
       * If helicopter + guided missiles, ensure CPU is above human chopper
       * OR near top of screen as missiles "fall" downward.
       */

      // special case: don't fire dumb / aimed missiles when target is above, unless near top of screen.
      if (!levelFlags.bullets && targetData.y < data.y && data.y > 48) return;

      // queue action.
      data.votes.ammo++;
      data.ammoTargets.push(targetData);
      options.exports.checkFacingTarget(target);
    }
  }

  function maybeFireOrBomb(data, options) {
    if (!data.bombing && data.votes.bomb) {
      options.exports.callAction('setBombing', true);
    } else if (data.bombing && !data.votes.bomb) {
      options.exports.callAction('setBombing', false);
    }

    if (!data.firing && data.votes.ammo) {
      options.exports.callAction('setFiring', true);
    } else if (data.firing && !data.votes.ammo) {
      options.exports.callAction('setFiring', false);
      data.ammoTarget = null;
    }

    if (data.firing && data.ammo) {
      // TODO: ensure fire rate is set based on current (active/closest) target
      data.ammoTargets.sort(utils.array.compare('x'));
      data.ammoTarget = data.ammoTargets[0];
      options.exports.setCPUFiringRate(data.ammoTargets[0]?.type);
    }

    if (data.bombing && data.bombs) {
      // TODO: ensure bomb rate is set based on active target
      data.bombTargets.sort(utils.array.compare('x'));
      options.exports.setCPUBombingRate(data.bombTargets[0]?.type);
    }
  }

  function maybeDropParatroopersNearTarget(target) {
    if (!target) return;

    let tData = target.data;

    if (!tData) return;

    // only run once in a while
    if (paratrooperDropTimer) return;

    let isBunker = target.data.type === TYPES.bunker;
    let isSuperBunker = target.data.type === TYPES.superBunker;
    let isEndBunker = target.data.type === TYPES.endBunker;

    // bunker, super-bunker, end-bunker case: approximately above enemy target?
    if (
      (isBunker || isSuperBunker || isEndBunker) &&
      !collisionCheckX(tData, data)
    )
      return;

    if (target.data.type === TYPES.turret) {
      // turret case: we must be approaching, not directly over or past the target.

      // firstly, we also don't want to be too far away.
      if (distance(data.x, tData.x) > 64) return;

      if (data.isEnemy && data.x < tData.x + tData.width) return;
      if (!data.isEnemy && data.x + data.width > tData.x) return;
    }

    // "Nearby friends" check, be efficient - e.g., infantry already nearby certain targets that will do the work.
    if (!isSuperBunker && !isEndBunker) {
      let friendsInView = objectsInView(data, {
        items: [TYPES.parachuteInfantry, TYPES.infantry],
        friendlyOnly: true
      });

      let validFriends = friendsInView.filter((f) => {
        /**
         * Paratrooper / infantry must be moving toward the target - not already past it.
         * Account for enemy and "friendly" CPUs, since human players can have friendly CPUs in network games.
         */
        f = getObjectById(f);
        if (!f) return;
        return (
          (f.data.isEnemy && f.data.x > tData.x + tData.halfWidth) ||
          (!f.data.isEnemy && f.data.x + f.data.width < tData.x)
        );
      });

      if (validFriends.length) return;
    }

    // at this point, mark that deployment is happening.
    paratrooperDropTimer = common.setFrameTimeout(() => {
      paratrooperDropTimer = null;
    }, paratrooperDropDelay);

    // Super Bunker / end bunker case: always drop all.
    // otherwise: drop ALL vs. one or two, if under 50% energy or bombs.
    if (
      isSuperBunker ||
      isEndBunker ||
      data.energy < data.energyMax >> 1 ||
      data.bombs < data.maxBombs >> 1
    ) {
      return dropAllParatroopersAtRandom(FPS * 5);
    }

    // "fast" deploy, does efficiency + accuracy matter?
    // if a turret, allow dropping a bunch if on a higher difficulty.
    let minimalDelay =
      tData.type === TYPES.turret &&
      (gameType === 'tutorial' || gameType === 'easy');

    // drop within the next few frames
    dropParatroopersAtRandom(rngInt(FPS * 5, TYPES.helicopter), minimalDelay);
  }

  function respondToHit(attackerID) {
    /**
     * At this point, we've been hit by something.
     * If from a helicopter, maybe start targeting choppers.
     */

    let attacker = getObjectById(attackerID);

    if (!attacker?.data) return;

    if (
      !data.targeting.helicopters &&
      // NOTE: parentType for munitions e.g., gunfire from chopper
      attacker.data.parentType === TYPES.helicopter
    ) {
      maybeChaseHelicopters();
    }

    // and, maybe fire a smart missile regardless!
    return maybeRetaliateWithSmartMissile(attacker);
  }

  function maybeChaseHelicopters() {
    // gate behind level config AND attack flag.
    if (!levelConfig.killCopterB || !data.targeting.attackB) return;

    if (data.targeting.helicopters) return;

    // if hit or under attack, maybe start pursuit.
    if (respondToHitTimer) return;

    // throttle, so not every (e.g.) bullet hit or dodge triggers a roll of the dice.
    respondToHitTimer = common.setFrameTimeout(() => {
      data.targeting.helicopters = data.targeting.attackB && rngBool(data.type);
      respondToHitTimer = null;
    }, respondToHitDelay);
  }

  function maybeEngageRetaliationMode() {
    // in certain cases, e.g., responding to being a smart missile target: set retaliation mode.
    // this allows CPU choppers to fly at full VX speed despite possible VX clipping.

    // this "feature" is gated by level config AND local state.
    if (!levelConfig.killCopterB || !data.targeting.attackB) return;

    // already active?
    if (data.targeting.retaliation) return;

    common.setFrameTimeout(() => {
      data.targeting.retaliation = false;
    }, retaliationModeDuration);
  }

  function maybeRetaliateWithSmartMissile(attacker) {
    /**
     * Potential retaliation: Launch smart missile(s) if damaged sufficiently
     * by opposing helicopter gunfire depending on game difficulty, OR, when
     * armed with "dumb" aimed missiles, and out of those.
     */

    // don't do this in certain modes.
    if (tutorialMode) return;

    // common case: armed with bullets.
    if (levelFlags.bullets) {
      // need to be damaged, depending on difficulty
      if (data.energy > missileEnergyThreshold) return;

      // and shot by helicopter gunfire
      if (!attacker?.data) return;
      if (attacker.data.type !== TYPES.gunfire) return;
      if (attacker.data.parentType !== TYPES.helicopter) return;
    } else {
      // aimed missile case: fire at any time if extreme - otherwise, fire when out of aimed missiles.
      if (gameType !== 'extreme' && data.ammo) return;
    }

    maybeFireMissileAtHelicopter();
  }

  function maybeFireMissileAtHelicopter() {
    // need to be "allowed" to use missiles, per level config
    if (!levelConfig.useMissileB) return;

    // throttle, ignore if active
    if (missileLaunchTimer) return;

    // need to be armed
    if (!data.smartMissiles) return;

    // look for nearby helicopter
    let mTarget = getObjectById(
      objectInView(data, { items: TYPES.helicopter })
    );

    if (!mTarget) return;

    // are there other active missiles targeting the attacking chopper?
    // launch more only if in extreme mode.
    let similarMissileCount = 0,
      i,
      j;

    for (i = 0, j = game.objects[TYPES.smartMissile].length; i < j; i++) {
      if (game.objects[TYPES.smartMissile][i].objects.target === mTarget) {
        similarMissileCount++;
      }
    }

    if (oneMissileOnly && similarMissileCount) return;

    let delay = rngInt(1000, TYPES.helicopter);

    if (similarMissileCount) {
      // extend delay when launching "additional" missiles
      delay += rngInt(3000, TYPES.helicopter);
    }

    missileLaunchTimer = common.setFrameTimeout(() => {
      // sanity check, given delay / async...
      if (data.dead || mTarget.data.dead) {
        missileLaunchTimer = null;
        return;
      }

      maybeEngageRetaliationMode();

      // "AI" target for helicopter missile launch method
      // (predetermined rather than real-time, because reasons.)
      missileTarget = mTarget;

      // it's possible the CPU is being chased, needs to flip to fire.
      options.exports.checkFacingTarget(mTarget);

      options.exports.setMissileLaunching(true);

      // and, stop momentarily.
      common.setFrameTimeout(() => {
        options.exports.setMissileLaunching(false);
        missileLaunchTimer = null;
      }, 1 / FPS);
    }, delay);
  }

  function maybeTakeOutEndBunker() {
    if (!data.targeting.endBunkers) return;

    // also required: paratroopers
    if (!data.parachutes) return;

    let opponentBank = game.objects[TYPES.endBunker][data.isEnemy ? 0 : 1];
    let targetX = opponentBank.data.x;
    let funds = opponentBank.data.funds;

    // CPU can try to steal funds / bunker if `killEndB` and minimum funds to steal, OR, you're too rich to ignore.
    if (
      !(
        (levelConfig.killEndB && funds > levelConfig.fundMinI) ||
        funds > levelConfig.fundMaxI
      )
    )
      return;

    // distance to target...
    let distX = data.isEnemy ? data.x - targetX : targetX - data.x;

    /**
     * From original: funds-to-distance ratio.
     * Enemy helicopter has to be within a certain range before it can make an end run.
     * More funds to steal = greater distance; e.g., 50% battlefield distance (4096) >> 6 = 64 (funds)
     * ∴ 128 funds = whole battlefield.
     */
    if (distX >> 6 >= funds) return;

    // OK to target end bunker
    if (seekEndBunker(data)) {
      // within range: drop
      dropAllParatroopersAtRandom();
    }
  }

  return {
    animate: ai,
    canBombTarget,
    addBomb,
    clearBombWithDelay,
    removeBomb,
    getMissileTarget: () => missileTarget,
    onHit: respondToHit,
    maybeChaseHelicopters,
    maybeDecoySmartMissile,
    maybeFireSmartMissileAtTurret,
    maybeDropParatroopersNearTarget,
    maybeRetaliateWithSmartMissile,
    resetSineWave
  };
};

export { HelicopterAI };
