import { game, getObjectById } from '../core/Game.js';
import { EVENTS, gameEvents } from '../core/GameEvents.js';
import { utils } from '../core/utils.js';
import { gameType, keyboardMonitor, prefsManager, screenScale } from '../aa.js';

import {
  bananaMode,
  defaultMissileMode,
  rubberChickenMode,
  FPS,
  isiPhone,
  isMobile,
  rnd,
  rndInt,
  plusMinus,
  tutorialMode,
  TYPES,
  worldWidth,
  worldHeight,
  worldOverflow,
  oneOf,
  getTypes,
  rngInt,
  rng,
  rngPlusMinus,
  clientFeatures,
  GAME_SPEED_RATIOED,
  GAME_SPEED,
  DEFAULT_LIVES,
  debug,
  debugCollision
} from '../core/global.js';

import {
  playSound,
  stopSound,
  sounds,
  playImpactWrench,
  playRepairingWrench,
  skipSound,
  playSoundWithDelay
} from '../core/sound.js';

import {
  collisionCheck,
  collisionCheckMidPoint,
  collisionTest,
  getNearestObject,
  isFacingTarget
} from '../core/logic.js';

import { common } from '../core/common.js';
import { gamePrefs } from '../UI/preferences.js';
import { getLandscapeLayout } from '../UI/mobile.js';
import { domFettiBoom } from '../UI/DomFetti.js';
import { zones } from '../core/zones.js';
import { effects } from '../core/effects.js';
import { net } from '../core/network.js';
import { sprites } from '../core/sprites.js';
import { levelConfig, levelFlags } from '../levels/default.js';
import { seek, Vector } from '../core/Vector.js';
import { HelicopterAI } from './Helicopter-AI.js';
import { getDefeatMessage } from '../levels/battle-over.js';
import { findEnemy } from './Helicopter-utils.js';
import { gamepad } from '../UI/gamepad.js';
import { aaLoader } from '../core/aa-loader.js';

function aiRNG(exports, number) {
  let { data } = exports;
  return rng(number, data.type, data.aiSeedOffset);
}

const Helicopter = (options = {}) => {
  let css,
    data,
    dom,
    domCanvas,
    events,
    exports,
    firingRates = getFiringRates(),
    objects,
    collision,
    radarItem,
    nextMissileTarget,
    statsBar,
    timers = {};

  function initHelicopter(exports) {
    let { data, dom, options } = exports;

    updateFiringRates(exports);

    if (data.isCPU || data.isRemote) {
      // offset fire modulus by half, to offset sound
      data.frameCount = Math.floor(data.fireModulus / 2);
    }

    dom.fuelLine = document.getElementById('fuel-line');

    dom.oSpinner = document.getElementById('spinner');

    // before we move, or anything else - determine xMax + yMax.
    refreshCoords(exports);

    // if not specified (e.g., 0), assign landing pad position.
    if (!data.x) {
      data.x = common.getLandingPadOffsetX(exports);
    }

    centerView(exports);

    // sign up with the local "bank."
    game.objects[TYPES.endBunker][data.isEnemy ? 1 : 0].registerHelicopter(
      exports
    );

    // for human player: append immediately, so initial game start / respawn animation works nicely
    sprites.updateIsOnScreen(exports);

    if (net.active) {
      callAction(exports, 'setRespawning', true);
    } else {
      // non-network, local player(s)
      setRespawning(exports, true);
    }

    // attach events?

    if (options.attachEvents && !isMobile) {
      // TODO: static DOM reference.
      utils.events.add(window, 'scroll', (e) => {
        // don't allow scrolling at all?
        e.preventDefault();
        return false;
      });
    }

    if (data.isLocal) {
      updateStatusUI(exports, { force: true });
      updateLives(exports);
    }

    radarItem = game.objects.radar.addItem(exports, { canRespawn: true });

    exports.radarItem = radarItem;

    radarItem.summon();
  }

  css = common.inheritCSS({
    className: TYPES.helicopter,
    animating: 'animating',
    active: 'active',
    disabled: 'disabled',
    repairing: 'repairing',
    unavailable: 'weapon-unavailable',
    reloading: 'weapon-reloading'
  });

  // computer player
  let isCPU = !!options.isCPU;

  const energy = 20;

  data = common.inheritData(
    {
      type: TYPES.helicopter,
      isCPU,
      isLocal: !!options.isLocal,
      isRemote: !!options.isRemote,
      attachEvents: !!options.attachEvents,
      angle: 0,
      excludeBlink: true, // TODO: review
      lastReactionSound: null,
      commentaryLastExec: 0,
      commentaryThrottle: 30000,
      excludeFromCollision: false,
      pickupSound: null,
      tiltOffset: 0,
      shakeOffset: 0,
      shakeOffsetMax: 6,
      shakeThreshold: 7,
      bombing: false,
      exploding: false,
      firing: false,
      fireFrameCount: 0,
      respawning: undefined,
      respawningDelay: 1600,
      missileLaunching: false,
      missileLaunchingFrameCount: 0,
      missileLaunchingModulus: 5,
      missileReloading: false,
      missileReloadingDelay: 500,
      parachuting: false,
      parachutingThrottle: false,
      // hackish: setFiringRate() expects exports.
      parachutingDelayFlying: setFiringRate(
        { firingRates },
        'parachutingDelayFlying'
      ),
      parachutingDelayLanded: setFiringRate(
        { firingRates },
        'parachutingDelayLanded'
      ),
      ignoreMouseEvents: !!game.objects.editor,
      fuel: 100,
      maxFuel: 100,
      needsFuel: 25,
      fireModulus: setFiringRate({ firingRates }, 'fireModulus'),
      bombModulus: setFiringRate({ firingRates }, 'bombModulus'),
      bombFrameCount: 0,
      bombRepairModulus: 10,
      fuelRateLanded: tutorialMode ? 18 : 9,
      fuelRateFlying: tutorialMode ? 9 : 4.5,
      parachuteFrameCount: 0,
      parachuteModulus: setFiringRate({ firingRates }, 'parachuteModulus'),
      repairModulus: 2,
      radarJamming: 0,
      repairComplete: false,
      landed: true,
      landingPad: null,
      onLandingPad: true,
      hasLiftOff: false,
      cloaked: false,
      cloakedFrameStart: 0,
      wentIntoHiding: false,
      wentIntoHidingSeconds: 1.5,
      stealth: levelFlags.stealth,
      flipped: false,
      // if player is remote (via network,) then flip events are sent via network.
      autoFlip: options.isRemote ? false : isCPU || gamePrefs.auto_flip,
      // allow CPU to move back and forth a bit without flipping
      autoFlipThreshold: isCPU ? 3 : 0,
      repairing: false,
      repairFrames: 0,
      dieCount: 0,
      ejectCount: 0,
      energy,
      energyMax: energy,
      energyRepairModulus: 10,
      energyLineScale: 0.25,
      bnbMediaActive: false,
      direction: 0,
      defaultDirection: true,
      pilot: true,
      timers: {},
      xMin: 0,
      xMax: null,
      xMaxOffset: 0,
      yMin: 0,
      yMax: null,
      yMaxOffset: 3,
      vX: 0,
      vXMax: 12,
      // CPU: relative to level config, original scale / speed limit of MAXVELX = 14
      // I *think* the CPU is limited in speed in some, but not all cases.
      /**
       * Cases where VX is NOT clipped (`cwGotoHB()` / `cwFlyToB()`):
       * - Taking out end bunker
       * - Moving to position to bomb targets - `cwBombTargetB()`
       * - Moving to position to fire missiles?
       * - Moving to landing pad
       * - Moving to take out bunker
       * - Moving to take out super bunker
       * - Moving to take out anti-aircraft gun
       * - Moving to get men (on ground)
       * - Moving to "kill copter", `killCopterB`
       * - "Refit" - flying back to landing pad(s)
       * - Flying to other side of opposing helicopter to shoot (avoid / dodge?)
       * - Suicide run
       */
      vXMaxClipped:
        isCPU && levelConfig.clipSpeedI
          ? (levelConfig.clipSpeedI / 14) * 12
          : 12,
      vYMax: 10,
      vY: 0,
      vyMin: 0,
      width: 48,
      height: options.isEnemy ? 18 : 15,
      halfWidth: 24,
      halfHeight: 7,
      halfHeightAdjusted: 3.5,
      tilt: null,
      lastTiltCSS: null,
      tiltYOffset: 0.25,
      // TODO: practice mode - helicopter given 3x all munitions and up to 15 paratroopers, repair speed also increases to match.
      /*
      void refuelCopter(register itemP copterIP, register playerP thePP)
      {
        Boolean	handicapB;
        
        handicapB						= theGame.practiceB && thePP->iType == LOCALPLAYER;
        copterIP->data.copter.iTargetV	= min(copterIP->data.copter.iTargetV, PADTOP);
        ITEMB(copterIP)					= PADTOP;
        copterIP->pAcc.h				=
        copterIP->pVel.h				= 0;
        thePP->ulCreateTime				= ulGameClock;
        thePP->iFuel					= min(thePP->iFuel+32, MAXFUEL);
        thePP->padTimeI++;
        if (handicapB || !(thePP->padTimeI & 3)) {
          copterIP->iHits		= min(thePP->myTP->copterHitsI, copterIP->iHits + 1);

          thePP->iBombs	= min(thePP->myTP->maxBombsI, thePP->iBombs + 1);
          thePP->iDumb	= min(thePP->myTP->maxDumbI, thePP->iDumb + !(thePP->padTimeI & 7));
          thePP->iRounds	= min(thePP->myTP->maxRoundsI, thePP->iRounds+2);

          if (thePP->iMissiles != thePP->myTP->maxMissilesI
            && !(thePP->padTimeI & (handicapB ? 15 : 63)))
            thePP->iMissiles++;
        }
      }

        void openTeamsLevel()
      {
              short	iTeam;
        register	teamP	theTP;

        for (iTeam = 2; iTeam--;) {
          Boolean	handicapB;
          
          theTP				= &theTeams[iTeam];
          handicapB			= theTP->humanB && theGame.practiceB;
          theTP->ulBuildTime	= ulGameClock;
          theTP->iBuildQueue	= 0;			// No items in queue to be built
          theTP->bResign		= false;
          theTP->iBuildItem	= NOITEM;
          theTP->captureTimeI	=
          theTP->createdI		=
          theTP->reqTimeI		= 0;
          theTP->maxRoundsI	= handicapB ? MAXROUNDS*3 : MAXROUNDS;
          theTP->maxDumbI		= handicapB ? MAXDUMB*3 : MAXDUMB;
          theTP->maxBombsI	= handicapB ? MAXBOMBS*3 : MAXBOMBS;
          theTP->maxMissilesI	= handicapB ? MAXMISSILES*3 : MAXMISSILES;
          theTP->maxMenI		= handicapB ? MAXMEN*3 : MAXMEN;
          theTP->copterHitsI	= handicapB ? 60 : 20;
        }
        openPlayersLevel(); 
      }
      */
      ammo: tutorialMode ? 192 : levelFlags.bullets ? 64 : 6,
      // note: bullets vs. "aimed missiles" logic, here
      maxAmmo: tutorialMode ? 192 : levelFlags.bullets ? 64 : 6,
      ammoRepairModulus: tutorialMode || levelFlags.bullets ? 2 : 20,
      bombs: tutorialMode ? 30 : 10,
      maxBombs: tutorialMode ? 30 : 10,
      parachutes: isCPU ? 5 : tutorialMode ? 1 : 0,
      maxParachutes: 5,
      bnbNoParachutes: false,
      smartMissiles: 2,
      maxSmartMissiles: 2,
      smartMissileRepairModulus: 128,
      midPoint: null,
      trailerCount: 12,
      xHistory: [],
      yHistory: [],
      isKamikaze: false,
      // for AI
      targeting: {
        attackB: false,
        defendB: false,
        stealB: false,
        clouds: false,
        endBunkers: false,
        helicopters: false,
        tanks: false,
        bunkers: false,
        superBunkers: false,
        turrets: false,
        men: false,
        vans: false,
        retaliation: false
      },
      targetingModulus: FPS * 30,
      // chance per gameType
      bombingThreshold: {
        easy: 0.9,
        hard: 0.85,
        extreme: 0.75
      },
      useClippedSpeed: false,
      x: options.x || 0,
      y: options.y || game.objects.view.data.world.height - 20,
      muchaMuchacha: false,
      cloakedCommentary: false,
      domFetti: {
        colorType: options.isEnemy ? 'grey' : 'green',
        elementCount: 256 + rndInt(512),
        startVelocity: 15 + rndInt(32),
        spread: 360,
        decay: 0.95
      },
      // things originally stored on the view
      // NOTE: start at 50% / 100%, i.e,. on landing pad.
      mouse: {
        x: 0.5,
        y: 1,
        vX: 0,
        vY: 0,
        mouseDown: false
      },
      // a buffer for local input delay.
      mouseHistory: new Array(32),
      missileMode: null,
      blinkCounter: 0,
      // TODO: DRY / optimize
      blinkCounterHide: 8 * (FPS / 30),
      blinkCounterReset: 16 * (FPS / 30),
      lives: DEFAULT_LIVES,
      livesLost: 0,
      livesPurchased: 0,
      votes: {
        ammo: 0,
        bomb: 0
      }
    },
    options
  );

  // each helicopter gets a unique random number generator seed.
  data.aiSeedOffset = data.id.split('_')[1] || 0;

  data.midPoint = {
    x: data.x + data.halfWidth + 10,
    y: data.y,
    width: 5,
    height: data.height
  };

  if (data.isLocal) {
    statsBar = document.getElementById('stats-bar');
  }

  // TODO: clean this up
  let lastMissileTarget;

  timers = {
    commentaryTimer: null,
    missileReloadingTimer: null,
    parachutingTimer: null,
    flipTimer: null,
    spinnerTimer: null
  };

  dom = {
    fuelLine: null,
    oSpinner: null,
    statsBar,
    // hackish
    statusBar: (() => {
      if (!statsBar) return;
      return {
        infantryCount: document.getElementById('infantry-count'),
        infantryCountLI: statsBar?.querySelectorAll('li.infantry-count')[0],
        ammoCount: document?.getElementById('ammo-count'),
        ammoCountLI: statsBar?.querySelectorAll('li.ammo')[0],
        bombCount: document.getElementById('bomb-count'),
        bombCountLI: statsBar.querySelectorAll('li.bombs')[0],
        missileCount: document.getElementById('missile-count'),
        missileCountLI: statsBar.querySelectorAll('li.missiles')[0]
      };
    })()
  };

  domCanvas = {
    radarItem: null, // see below: Helicopter.radarItemConfig(exports)
    img: {
      src: null,
      animationModulus: Math.floor(FPS * (1 / GAME_SPEED) * (1 / 21)), // 1 / 10 = 1-second animation
      frameCount: 0,
      animationFrame: 0,
      animationFrameCount: 0,
      isSequence: true,
      source: {
        x: 0,
        y: 0,
        is2X: true,
        width: 0,
        height: 0,
        frameWidth: 0,
        frameHeight: 0,
        frameX: 0,
        frameY: 0
      },
      target: {
        width: 0,
        height: 0
      }
    }
  };

  events = {
    resize() {
      refreshCoords(exports);
    },

    mousedown(e) {
      let args;

      data.mouse.mouseDown = true;

      if (e.button !== 0 || isMobile || data.isCPU || !data.fuel) return;

      if (!game.data.battleOver) {
        if (!data.autoFlip) {
          flip(exports);
        }
      } else {
        // battle over; determine confetti vs. shrapnel.

        // if clicking a button, don't do anything.
        if (e.target.tagName.match(/a|button/i)) return;

        const ss = game.objects.view.data.screenScale;

        if (game.data.theyWon) {
          // dirty, dirty tricks: overwrite helicopter coordinates.
          data.x =
            e.clientX * (1 / ss) +
            game.objects.view.data.battleField.scrollLeft;
          data.y = e.clientY * (1 / ss);

          const count = 16 + rndInt(16);

          effects.shrapnelExplosion(data, {
            count,
            velocity: 4 + rngInt(4 + count / 4, TYPES.shrapnel),
            // first burst always looks too similar, here.
            noInitialSmoke: true
          });

          effects.smokeRing(data.id);

          effects.inertGunfireExplosion({ exports, count: 4 + rndInt(4) });
        } else {
          args = {
            x:
              e.clientX * (1 / ss) +
              game.objects.view.data.battleField.scrollLeft,
            y: e.clientY * (1 / ss),
            vX: 1 + rndInt(8),
            vY: -rndInt(10),
            width: 1,
            height: 1,
            halfWidth: 1,
            halfHeight: 1,
            isOnScreen: true
          };

          playSound(sounds.balloonExplosion, exports);

          const elementCount = 32 + rndInt(384);

          const options = {
            data: {
              domFetti: {
                colorType: oneOf(['default', 'green', 'yellow', 'grey']),
                elementCount,
                spread: 360,
                startVelocity: 20 + rndInt(elementCount / 12),
                decay: 0.95
              }
            }
          };

          game.objects.domFetti.push(
            domFettiBoom(options, null, args.x, args.y)
          );

          effects.smokeRing(
            { data: args },
            {
              velocityMax: 5,
              count: 8 + rndInt(8)
            }
          );
        }
      }
    },
    mouseup(e) {
      data.mouse.mouseDown = false;
    }
  };

  objects = {
    bombs: [],
    smartMissiles: []
  };

  // enemy chopper is a bit bigger.
  const defaultWidth = data.isEnemy ? 110 : 100;
  const defaultHeight = data.isEnemy ? 36 : 32;

  const rotatingWidth = 100;
  const rotatingHeight = data.isEnemy ? 42 : 40;

  const spriteConfig = {
    default: {
      getImage: () =>
        `helicopter${data.isEnemy ? '-enemy' : ''}${data.flipped ? '-rotated' : ''}_#.png`,
      width: defaultWidth,
      height: defaultHeight,
      frameWidth: defaultWidth,
      frameHeight: defaultHeight,
      animationConfig: {
        animationDuration: 0.85,
        loop: true,
        isSequence: true,
        animationFrameCount: 4
      }
    },
    rotating: {
      getImage: () => {
        if (data.isEnemy) return 'helicopter-rotating-enemy_#.png';
        return 'helicopter-rotating_#.png';
      },
      width: rotatingWidth,
      height: rotatingHeight,
      frameWidth: rotatingWidth,
      frameHeight: rotatingHeight,
      // vertical sprite
      animationConfig: {
        animationDuration: 0.7,
        isSequence: true,
        animationFrameCount: 3,
        onEnd: () => {
          // back to default sprite.
          swapSprite(exports, spriteConfig.default, {
            skipFrame: true
          });
        }
      }
    }
  };

  exports = {
    animate: () => animate(exports),
    callAction: (method, value) => callAction(exports, method, value),
    centerView: () => centerView(exports),
    checkFacingTarget: (target) => checkFacingTarget(exports, target),
    css,
    data,
    dom,
    domCanvas,
    die: (dieOptions) => die(exports, dieOptions),
    eject: () => eject(exports),
    events,
    fire: () => fire(exports),
    firingRates,
    flip: (force) => flip(exports, force),
    init: () => initHelicopter(exports),
    isFacingTarget,
    lastMissileTarget,
    nextMissileTarget,
    objects,
    onHit: (attacker) => onHit(exports, attacker),
    onKill: (targetID) => onKill(exports, targetID),
    onLandingPad: (state, pad) => onLandingPad(exports, state, pad),
    options,
    reactToDamage: (attacker) => reactToDamage(exports, attacker),
    reset: () => reset(exports),
    refreshCoords: () => refreshCoords(exports),
    setBombing: (state) => setBombing(exports, state),
    setCPUBombingRate: (targetType) => setCPUBombingRate(exports, targetType),
    setCPUFiringRate: (targetType) => setCPUFiringRate(exports, targetType),
    setFiring: (state) => setFiring(exports, state),
    setMissileLaunching: (state, missileModeFromNetwork) =>
      setMissileLaunching(exports, state, missileModeFromNetwork),
    setParachuting: (state) => setParachuting(exports, state),
    setRespawning: (state) => setRespawning(exports, state),
    spriteConfig,
    startRepairing: () => startRepairing(exports),
    timers,
    toggleAutoFlip: () => toggleAutoFlip(exports),
    updateFiringRates: () => updateFiringRates(exports),
    updateLives: (plusOrMinusOneLife) =>
      updateLives(exports, plusOrMinusOneLife),
    updateStatusUI: (updateParams) => updateStatusUI(exports, updateParams)
  };

  // randomize "AI" timing a bit
  data.targetingModulus += Math.floor(aiRNG(exports, 15));

  domCanvas.radarItem = Helicopter.radarItemConfig({ exports, data });

  if (options.isCPU) {
    data.ai = HelicopterAI({ exports });
  }

  swapSprite(exports);

  collision = {
    options: {
      source: data.id,
      targets: undefined,
      hit(targetID) {
        let target = getObjectById(targetID);
        const tData = target.data;
        if (tData.type === TYPES.chain) {
          // special case: chains do damage, but don't kill.
          common.hit(data.id, tData.damagePoints, targetID);
          // and make noise.
          if (sounds.chainSnapping) {
            playSound(sounds.chainSnapping, target);
          }
          if (data.isLocal) {
            reactToDamage(exports, target);
          }
          // should the target die, too? ... probably so.
          common.hit(targetID, 999, data.id);
        } else if (tData.type === TYPES.infantry) {
          // helicopter landed, not repairing, and friendly, landed infantry (or engineer)?
          if (data.landed && !data.onLandingPad) {
            // check if it's at the helicopter "door".
            if (collisionCheckMidPoint(target, exports)) {
              // Per game tips: "infantry carry grenades" - and here's where they get used. Deadly!
              if (tData.isEnemy !== data.isEnemy) {
                game.objects.notifications.addNoRepeat(
                  'Your helicopter was hit with a grenade. 🚁'
                );
                die(exports, { attacker: target.data.id });
                return;
              }

              // bail if at capacity
              if (data.parachutes >= data.maxParachutes) return;

              // pick up infantry (silently)
              target.die({ silent: true });
              playSound(sounds.popSound, exports);
              if (gamePrefs.bnb) {
                const pickupSound =
                  sounds.bnb[
                    game.data.isBeavis
                      ? 'beavisInfantryPickup'
                      : 'buttheadInfantryPickup'
                  ];
                // only play if not already active, and delay before clearing.
                if (!data.pickupSound)
                  data.pickupSound = playSound(pickupSound, exports, {
                    onfinish: () =>
                      common.setFrameTimeout(
                        () => (data.pickupSound = null),
                        500
                      )
                  });
              }
              data.parachutes = Math.min(
                data.maxParachutes,
                data.parachutes + 1
              );

              // parachutes are changing, maybe more. TBD.
              let updateParams = { parachutes: true };

              // if an engineer, notify about repairs etc.
              if (tData.role) {
                game.objects.notifications.add(
                  'An engineer partially re-armed your chopper. 🚁'
                );

                // 50% energy boost
                data.energy = Math.min(
                  data.energyMax,
                  data.energy + data.energyMax / 2
                );

                // 12.5% fuel boost
                data.fuel = Math.min(100, data.fuel + 100 / 8);

                // one bomb
                data.bombs = Math.min(data.maxBombs, data.bombs + 1);

                // up to 32 bullets, OR, one "dumb" missile
                if (levelFlags.bullets) {
                  data.ammo = Math.min(
                    data.maxAmmo,
                    data.ammo + data.maxAmmo / 2
                  );
                } else {
                  // "dumb" missile
                  data.ammo = Math.min(data.maxAmmo, data.ammo + 1);
                }

                // only +1 smart missile, if you have zero left
                if (!data.smartMissiles) {
                  data.smartMissiles++;
                }
                updateParams = { force: true };
              }

              updateStatusUI(exports, updateParams);
            }
          }
        } else if (tData.type === TYPES.cloud) {
          cloak(exports, target);
        } else if (
          tData.type === TYPES.superBunker &&
          tData.isEnemy === data.isEnemy &&
          !tData.hostile
        ) {
          // "protect" the helicopter if completely enveloped within the bounds of a friendly super-bunker.
          // this check is added because sometimes the collision logic is imperfect, and fast-moving bombs or missiles might hit the "inner" chopper object. Oops. :D
          data.excludeFromCollision =
            data.y >= tData.y &&
            data.x >= tData.x &&
            data.x + data.width <= tData.x + tData.width;
        } else {
          // hit something else. boom!
          // special case: ensure we crash on the "roof" of a super-bunker.
          if (tData.type === TYPES.superBunker) {
            data.y = Math.min(
              worldHeight -
                (common.ricochetBoundaries[tData.type] || 0) -
                data.height,
              data.y
            );
            // stop falling, too
            data.vY = 0;
            // and go to adjusted position
            moveTo(exports, data.x, data.y);
          }
          die(exports, { attacker: targetID });
          // should the target die, too? ... probably so.
          common.hit(targetID, 999, data.id);
        }
      }
    },
    items: getTypes(
      'helicopter, superBunker:all, bunker, balloon, tank, van, missileLauncher, chain, infantry:all, engineer:all, cloud:all',
      { exports }
    )
  };

  exports.collision = collision;

  // hackish: assign to globals before init
  if (data.isLocal) {
    game.players.local = exports;
  } else if (data.isRemote) {
    game.players.remote.push(exports);

    if (!data.isCPU) {
      // just in case...
      if (game.players.remoteHuman)
        console.warn('WTF game.players.remoteHuman already defined???');

      game.players.remoteHuman = exports;
    }
  }
  if (data.isCPU) {
    // note: not mutually exlusive, can be local (for testing purposes) or remote
    game.players.cpu.push(exports);
  }

  // ensure the UI shows the appropriate unit colours
  if (data.isLocal && data.isEnemy) {
    utils.css.add(document.getElementById('player-status-bar'), 'enemy');
    utils.css.add(document.getElementById('mobile-controls'), 'enemy');
  }

  return exports;
};

Helicopter.radarItemConfig = ({ exports, data }) => ({
  width: 2.5 * (isiPhone ? 1.33 : 1),
  height: 2.5 * (isiPhone ? 1.33 : 1),
  draw: (ctx, obj, pos, width, height) => {
    // don't draw other team's choppers if playing a battle with steath mode, and not in view
    if (
      data?.cloaked ||
      (data.stealth &&
        !data.isOnScreen &&
        data.isEnemy !== game.players.local.data.isEnemy)
    )
      return;

    const isLocal = data.id === game.players.local.data.id;

    const radarData = exports.radarItem?.data;

    if (isLocal && radarData && data.blinkCounter >= 0) {
      // local chopper blinks continuously
      data.blinkCounter++;
      if (data.blinkCounter === data.blinkCounterHide) {
        radarData.visible = !radarData.visible;
      } else if (data.blinkCounter >= data.blinkCounterReset) {
        radarData.visible = !radarData.visible;
        data.blinkCounter = 0;
      }
    }

    // don't draw if not visible.
    if (isLocal && !radarData.visible && !data.respawning) return;

    const scaledWidth = pos.width(width);
    const scaledHeight = pos.heightNoStroke(height);

    // triangle depends on friendly / enemy + flip
    let direction = data.flipped ? 1 : -1;

    if (data.isEnemy) {
      // reverse for the enemy chopper.
      direction *= -1;
    }

    // TODO: review precise helicopter + landing pad alignment
    let left =
      Math.max(
        0 + scaledWidth,
        obj.data.left * game.objects.radar.data.scale -
          game.objects.radar.data.radarScrollLeft
      ) +
      scaledWidth / 2;

    // y offset, plus offset for "summon" transition
    const top =
      obj.data.top +
      (obj?.data?.stepOffset !== undefined
        ? scaledHeight * (1 - obj?.data?.stepOffset)
        : 0);

    // "center" triangle - not precisely...
    left += direction === -1 ? scaledWidth / 2 : -scaledWidth;

    ctx.beginPath();
    ctx.moveTo(left, top);
    ctx.lineTo(left + scaledWidth * direction, top + scaledHeight);
    ctx.lineTo(left + scaledWidth * direction, top - scaledHeight);
  }
});

function swapSprite(exports, newSprite, options = {}) {
  if (!newSprite) {
    newSprite = exports.spriteConfig.default;
  }
  let { domCanvas } = exports;
  const props = ['width', 'height', 'frameWidth', 'frameHeight'];
  props.forEach((prop) => {
    domCanvas.img.source[prop] = newSprite[prop];
  });
  // assign target width + height based on source frame width + height
  domCanvas.img.target.width = newSprite.frameWidth;
  domCanvas.img.target.height = newSprite.frameHeight;
  // animation?
  if (newSprite.animationConfig) {
    const { width, height, frameWidth, frameHeight } = newSprite;
    domCanvas.animation = common.domCanvas.canvasAnimation(exports, {
      skipFrame: !!options.skipFrame,
      sprite: {
        width,
        height,
        frameWidth,
        frameHeight,
        url: newSprite.getImage(),
        ...newSprite.animationConfig
      },
      // TODO: move this into sprite or something
      useDataAngle: true,
      // TODO: this is also bad and needs moving.
      onEnd: newSprite.animationConfig.onEnd
    });
  }
}

function cloak(exports, cloud) {
  let { data, domCanvas } = exports;

  if (!data.cloaked) {
    doCloak(exports);
    cloud?.startDrift();
  }

  // hackish: mark and/or update the current frame when this happened.
  data.cloaked = game.objects.gameLoop.data.frameCount;

  data.opacity = 0.33;
  domCanvas.img.target.opacity = data.opacity;

  // Tough times with turrets? “The answer, my friend, is blowing in the wind.” 🌬️🚁
  cloud?.drift(data.isEnemy);
}

function doCloak(exports) {
  let { data } = exports;

  // mark the frame this began
  data.cloakedFrameStart = game.objects.gameLoop.data.frameCount;

  if (!data.isLocal || !sounds.helicopter.engine) return;

  if (sounds.helicopter.engine.sound)
    sounds.helicopter.engine.sound.setVolume(
      (sounds.helicopter.engineVolume * gamePrefs.volume) / 2.5
    );

  if (!gamePrefs.bnb) return;

  // additional commentary, once fully-cloaked
  common.setFrameTimeout(function () {
    if (!data.cloaked) return;

    const cloakSound =
      sounds.bnb[
        game.data.isBeavis ? 'beavisICantSeeAnything' : 'beavisComeOn'
      ];

    playSound(cloakSound, null, {
      onplay: (sound) => {
        if (!data.cloaked) skipSound(sound);
      },
      onfinish: (sound) => {
        if (sound.skipped || !data.cloaked) return;
        // allow "peek-a-boo!"
        data.cloakedCommentary = true;
      }
    });
  }, 2000);
}

function updateCloakState(exports) {
  let { data } = exports;

  // a helicopter could be targeted by a smart missile, and become cloaked long enough to confuse tracking.
  data.wentIntoHiding =
    data.cloaked &&
    data.cloakedFrameStart > 0 &&
    game.objects.gameLoop.data.frameCount - data.cloakedFrameStart >=
      FPS * data.wentIntoHidingSeconds;
}

function uncloak(exports) {
  let { data, domCanvas } = exports;

  // uncloak if 1+ frame has passed, and we aren't in a cloud.
  if (!data.cloaked || data.cloaked === game.objects.gameLoop.data.frameCount)
    return;

  if (gamePrefs.bnb && data.isLocal && data.cloakedCommentary && !data.dead) {
    playSoundWithDelay(sounds.bnb.beavisPeekaboo, 250);
  }

  if (data.isLocal && sounds.helicopter.engine) {
    if (sounds.helicopter.engine.sound)
      sounds.helicopter.engine.sound.setVolume(
        sounds.helicopter.engineVolume * gamePrefs.volume
      );
  }

  data.cloaked = false;
  data.opacity = 1;
  domCanvas.img.target.opacity = data.opacity;
  data.cloakedFrameStart = 0;
  data.wentIntoHiding = false;
  data.cloakedCommentary = false;
}

function centerView(exports) {
  let { data } = exports;

  // don't let errant calls center the view on remote / CPU choppers.
  if (!data.isLocal) return;

  // "get to the choppa!" (center the view on it, that is.)
  game.objects.view.setLeftScrollToPlayer(exports);
}

function updateFuelUI(exports) {
  let { data, dom } = exports;

  if (!data.isLocal) return;

  dom.fuelLine.style.transform = `translate3d(${100 - (100 - data.fuel)}%, 0px, 0px)`;

  if (data.repairing || tutorialMode) return;

  // hackish: show announcements across 1% of fuel burn process.

  let text;

  if (data.fuel < 33 && data.fuel > 32) {
    text = 'Low fuel <span class="inline-emoji">⛽ 🤏 😬</span>';

    game.objects.view.setAnnouncement(text);
    game.objects.notifications.addNoRepeat(text);

    if (gamePrefs.bnb) {
      playSound(
        game.data.isBeavis ? sounds.bnb.hurryUpButthead : sounds.bnb.uhOh,
        exports
      );
    }
  } else if (data.fuel < 16 && data.fuel > 15) {
    text = 'Fuel critical <span class="inline-emoji">⛽ 🤏 😱</span>';

    game.objects.view.setAnnouncement(text);
    game.objects.notifications.addNoRepeat(text);

    if (gamePrefs.bnb) {
      playSound(
        game.data.isBeavis
          ? sounds.bnb.beavisLostUnit
          : sounds.bnb.buttheadLostUnit,
        exports
      );
    }
  } else if (data.fuel <= 0) {
    text = 'No fuel <span class="inline-emoji">💀</span>';

    game.objects.view.setAnnouncement(text);
    game.objects.notifications.addNoRepeat(text);

    if (gamePrefs.bnb) {
      playSound(
        game.data.isBeavis
          ? sounds.bnb.beavisEjectedHelicopter
          : sounds.bnb.buttheadEjectedHelicopter,
        exports
      );
    }
  }
}

function burnFuel(exports) {
  let { data } = exports;

  // don't burn fuel in these cases
  if (data.dead || data.repairing) return;

  const burnRate = data.landed ? data.fuelRateLanded : data.fuelRateFlying;

  data.fuel = Math.max(
    0,
    data.fuel - ((0.1 * 1) / burnRate) * GAME_SPEED_RATIOED
  );

  updateFuelUI(exports);
}

function repairInProgress(exports) {
  let { data } = exports;

  return data.repairing && !data.repairComplete;
}

function iGotYouBabe() {
  if (!gamePrefs.bnb || !gamePrefs.muzak || !gamePrefs.sound) return;

  const { iGotYouBabe } = sounds.bnb;

  // determine our start point
  const offsets = [
    0,
    27850, // flute-ish melody: "duh duh, duh duh"
    39899 // guitar riff, "yes! rock!" 🎸🤘
  ];

  const from = offsets[iGotYouBabe.playCount] || 0;

  const options = { from };

  playSound(sounds.bnb.iGotYouBabe, null, options);

  if (++iGotYouBabe.playCount >= offsets.length) {
    iGotYouBabe.playCount = 0;
  }

  /**
   * https://www.youtube.com/watch?v=jyncsw3yq-k
   * ffmpeg -i cher.mp4 -ss 25 -t 73.5 -filter:v "crop=1420:1080:250:0,scale=352:-1" -c:v libx264 -an igotyoubabe.mp4
   * ffmpeg -i cher.mp4 -ss 25 -t 73.5 -filter:v "crop=1420:1080:250:0,scale=352:-1" -c:v libvpx-vp9 -an igotyoubabe.webm
   */
  common.setVideo('igotyoubabe', 1, from);

  game.objects.notifications.add('🎵 Now playing: “I Got You Babe” 🎸🤘', {
    noDuplicate: true
  });
}

function startRepairing(exports) {
  let { css, data, dom } = exports;

  if (data.repairing) return;

  data.repairing = true;

  // reset "counter" for missiles, etc.
  data.repairFrames = 0;

  if (!data.isLocal) return;

  setSpinner(exports, true);

  playSound(sounds.repairing);

  maybeStartRepairingMedia(exports);

  // start blinking certain things

  if (data.smartMissiles < data.maxSmartMissiles) {
    utils.css.add(dom.statusBar.missileCountLI, css.repairing);
  }

  if (data.ammo < data.maxAmmo) {
    utils.css.add(dom.statusBar.ammoCountLI, css.repairing);
  }

  if (data.bombs < data.maxBombs) {
    utils.css.add(dom.statusBar.bombCountLI, css.repairing);
  }

  common.setFrameTimeout(
    () => {
      playRepairingWrench(() => repairInProgress(exports), exports);
    },
    500 + rndInt(1500)
  );

  common.setFrameTimeout(
    () => {
      playImpactWrench(() => repairInProgress(exports), exports);
    },
    500 + rndInt(1500)
  );
}

function stopRepairing(exports) {
  let { css, data, dom } = exports;

  // GAME_SPEED: ensure we don't have any remaining fractional values
  data.ammo = Math.floor(data.ammo);
  data.bombs = Math.floor(data.bombs);
  data.smartMissiles = Math.floor(data.smartMissiles);

  // ensure counters aren't blinking
  if (data.isLocal) {
    utils.css.remove(dom.statusBar.ammoCountLI, css.repairing);
    utils.css.remove(dom.statusBar.bombCountLI, css.repairing);
    utils.css.remove(dom.statusBar.missileCountLI, css.repairing);

    setSpinner(exports, false);

    if (sounds.repairing) {
      stopSound(sounds.repairing);
    }

    if (data.repairComplete) {
      document.getElementById('repair-complete').style.display = 'none';
    }
  }

  data.repairing = false;
  data.repairComplete = false;
}

function maybeStartRepairingMedia(exports, force) {
  let { data } = exports;

  let landingPad = getObjectById(data.landingPad);

  const somethingIsEmpty = !data.smartMissiles || !data.bombs || !data.ammo;

  if (
    data.smartMissiles < data.maxSmartMissiles ||
    data.fuel < 33 ||
    somethingIsEmpty ||
    force
  ) {
    if (landingPad.data.isKennyLoggins) {
      // welcome to *** THE DANGER ZONE! ***
      if (!net.active && gamePrefs.muzak) {
        playSound(sounds.dangerZone, null);
      }
    } else if (gamePrefs.muzak) {
      if (gamePrefs.bnb) {
        if (landingPad.data.isMidway || somethingIsEmpty) {
          if (game.data.isBeavis) {
            if (Math.random() >= 0.25) {
              data.muchaMuchacha = true;
              if (gamePrefs.sound) {
                if (!force) {
                  game.objects.notifications.addNoRepeat(
                    '🎵 Now playing: “Mucha Muchacha” 🇲🇽🪅🍆',
                    { noDuplicate: true }
                  );
                }
                playSound(sounds.bnb.muchaMuchacha, null);
                data.bnbMediaActive = true;
                common.setVideo('camper', 1.05);
                // TODO: re-implement in Canvas. ;)
                // utils.css.add(dom.o, css.muchaMuchacha);
              }
            } else {
              if (!force) {
                game.objects.notifications.addNoRepeat(
                  '🎵 Now playing: “Ratfinks, Suicide Tanks And Cannibal Girls” 🎸🤘💥',
                  { noDuplicate: true }
                );
              }
              const muted = false;
              data.bnbMediaActive = true;
              common.setVideo('beavis-wz', 1, 1, muted);
            }
          } else {
            iGotYouBabe();
          }
        } else {
          playSound(sounds.bnb.theme, null);
        }
      } else if (gamePrefs.muzak) {
        // hit the chorus, if we'll be "a while."

        playSound(sounds.ipanemaMuzak, null, { position: 13700 });
        if (!force) {
          game.objects.notifications.addNoRepeat(
            '🎵 Now playing: “The Girl From Ipanema” 🎸🤘',
            { noDuplicate: true }
          );
        }
      }
    }

    if (!force) {
      game.objects.notifications.addNoRepeat(landingPad.data.welcomeMessage, {
        type: 'landingPad',
        noDuplicate: true
      });
    }
  } else if (gamePrefs.muzak) {
    if (landingPad.data.isKennyLoggins && !net.active) {
      // welcome to *** THE DANGER ZONE! ***
      playSound(sounds.dangerZone, null);
    } else if (gamePrefs.bnb) {
      playSound(sounds.bnb.theme, null);
    } else {
      // start from the beginning, if a shorter visit.
      playSound(sounds.ipanemaMuzak, null, { position: 0 });
    }
  }
}

function stopRepairingMedia(exports) {
  let { data } = exports;

  if (!data.isLocal) return;

  if (sounds.ipanemaMuzak) {
    stopSound(sounds.ipanemaMuzak);
  }

  if (sounds.dangerZone) {
    stopSound(sounds.dangerZone);
  }

  if (sounds.bnb?.theme) {
    stopSound(sounds.bnb.theme);
  }

  if (sounds.bnb?.muchaMuchacha) {
    data.muchaMuchacha = false;
    // hackish: ensure we reset any horizontal travel.
    stopSound(sounds.bnb.muchaMuchacha);
  }

  if (sounds.bnb?.iGotYouBabe) {
    stopSound(sounds.bnb.iGotYouBabe);
  }

  common.setVideo();

  data.bnbMediaActive = false;
}

// Status item
function modify(o, count, css) {
  if (count > 0) {
    utils.css.remove(o, css.unavailable);
  } else {
    utils.css.add(o, css.unavailable);
  }
}

function applyStatusUI(exports, updated) {
  let { css, data, dom } = exports;

  const { force } = updated;

  if (force || updated.parachutes) {
    dom.statusBar.infantryCount.innerText = data.parachutes;
  }

  if (force || updated.ammo) {
    dom.statusBar.ammoCount.innerText = Math.floor(data.ammo);
    if (updated.ammoComplete) {
      utils.css.remove(dom.statusBar.ammoCountLI, css.repairing);
    }
  }

  if (force || updated.bombs) {
    dom.statusBar.bombCount.innerText = Math.floor(data.bombs);
    if (updated.bombsComplete) {
      utils.css.remove(dom.statusBar.bombCountLI, css.repairing);
    }
  }

  if (force || updated.smartMissiles) {
    dom.statusBar.missileCount.innerText = Math.floor(data.smartMissiles);
    if (updated.smartMissilesComplete) {
      utils.css.remove(dom.statusBar.missileCountLI, css.repairing);
    }
  }

  let mobileControls;
  let mobileControlItems;

  mobileControls = document.getElementById('mobile-controls');
  mobileControlItems = mobileControls?.querySelectorAll(
    '.mobile-controls-weapons li'
  );

  if (force || updated.parachutes) {
    modify(dom.statusBar.infantryCountLI, data.parachutes, css);
    if (isMobile) modify(mobileControlItems[0], data.parachutes, css);
  }

  if (force || updated.smartMissiles) {
    modify(dom.statusBar.missileCountLI, data.smartMissiles, css);
    if (isMobile) modify(mobileControlItems[2], data.smartMissiles, css);
  }

  if (force || updated.ammo) {
    modify(dom.statusBar.ammoCountLI, data.ammo, css);
    if (isMobile) modify(mobileControlItems[1], data.ammo, css);
  }

  if (force || updated.bombs) {
    modify(dom.statusBar.bombCountLI, data.bombs, css);
    if (isMobile) modify(mobileControlItems[3], data.bombs, css);
  }

  // hackish, fix endBunkers reference
  if (force || updated.funds) {
    // update the funds UI
    game.objects.funds.setFunds(
      game.objects[TYPES.endBunker][data.isEnemy ? 1 : 0].data.funds
    );
  }
}

function updateLives(exports, plusOrMinusOneLife = 0) {
  let { data } = exports;

  // optional param: ±1 - presently used when purchasing additional choppers
  if (common.unlimitedLivesMode()) return;
  data.lives += plusOrMinusOneLife;
  if (plusOrMinusOneLife === 1) {
    data.livesPurchased++;
  }
  document.getElementById('lives-count').innerText = Math.max(0, data.lives);
}

function updateStatusUI(exports, updated) {
  let { data } = exports;

  // ignore enemy repair / updates, but apply player's changes
  if (
    data.isLocal &&
    (updated.funds ||
      updated.force ||
      updated.ammo ||
      updated.bombs ||
      updated.smartMissiles ||
      updated.parachutes)
  ) {
    game.objects.queue.addNextFrame(() => {
      applyStatusUI(exports, updated);
    });
  }

  // fully-repaired?
  if (
    data.repairing &&
    !data.repairComplete &&
    data.fuel === data.maxFuel &&
    data.ammo === data.maxAmmo &&
    data.energy === data.energyMax &&
    data.bombs === data.maxBombs &&
    data.smartMissiles === data.maxSmartMissiles
  ) {
    data.repairComplete = true;

    if (!data.isLocal) return;

    setSpinner(exports, false);
    document.getElementById('repair-complete').style.display = 'block';

    if (sounds.repairing) {
      stopSound(sounds.repairing);
    }

    if (sounds.bnb?.beavisThankYouDriveThrough) {
      playSound(sounds.bnb.beavisThankYouDriveThrough);
    }

    if (sounds.repairComplete) {
      playSound(sounds.repairComplete);
    }
  }
}

function repair(exports) {
  let { data } = exports;

  const updated = {};

  data.repairFrames++;

  data.fuel = Math.min(data.maxFuel, data.fuel + 0.25 * GAME_SPEED_RATIOED);

  if (
    data.ammo < data.maxAmmo &&
    data.repairFrames % data.ammoRepairModulus === 0
  ) {
    data.ammo = Math.min(data.maxAmmo, data.ammo + 1 * GAME_SPEED_RATIOED);
    updated.ammo = true;
    if (data.ammo >= data.maxAmmo) {
      // stop blinking
      updated.ammoComplete = true;
    }
  }

  // TODO: DRY / optimize
  if (data.repairFrames % data.energyRepairModulus === 0) {
    // fix damage (no UI for this)
    data.energy = Math.min(data.energyMax, data.energy + 1);
  }

  // TODO: DRY / optimize
  if (
    data.bombs < data.maxBombs &&
    data.repairFrames % data.bombRepairModulus === 0
  ) {
    data.bombs = Math.min(data.maxBombs, data.bombs + 1);
    updated.bombs = true;
    if (data.bombs >= data.maxBombs) {
      updated.bombsComplete = true;
    }
  }

  if (
    data.smartMissiles < data.maxSmartMissiles &&
    // TODO: DRY / optimize
    data.repairFrames % data.smartMissileRepairModulus === 0
  ) {
    data.smartMissiles = Math.min(
      data.maxSmartMissiles,
      data.smartMissiles + 1
    );
    updated.smartMissiles = true;
    if (data.smartMissiles >= data.maxSmartMissiles) {
      updated.smartMissilesComplete = true;
    }
  }

  sprites.updateEnergy(data.id);

  updateFuelUI(exports);
  updateStatusUI(exports, updated);

  if (!data.isLocal) return;

  if (gamePrefs.bnb && data.muchaMuchacha && data.repairFrames % 5 === 0) {
    if (rnd(1) < 0.25) return;

    const { sound } = sounds.bnb.muchaMuchacha;

    if (!sound) return;

    // hack: get position and whatnot
    // TODO: fix this
    sound._onTimer();

    // no motion, at first; "ramp up" the action at some point, and stop when finished.
    const offset = sound.position / sound.duration;

    const progress =
      !sound.playState || offset < 0.25 || offset > 0.9
        ? 0
        : Math.min(1, sound.position / (sound.duration * 0.66));

    data.tiltOffset = plusMinus(rnd(10 * progress));

    if (progress && Math.abs(data.tiltOffset) >= 2) {
      effects.inertGunfireExplosion({
        exports,
        count: 1 + rndInt(1),
        vY: 3 + rndInt(2)
      });
    }
  }
}

function checkFacingTarget(exports, target) {
  let { data } = exports;

  // ensure the enemy chopper is facing the target before firing.
  if (!target) return;

  // ignore direction and prevent excessive flipping when bombing tanks, or if hidden within a cloud
  if (data.bombing || data.cloaked) return;

  if (!isFacingTarget(target.data, data)) {
    flip(exports);
  }
}

function setFiring(exports, state) {
  let { data } = exports;

  if (
    state !== undefined &&
    (!data.onLandingPad || isMobile || (!state && data.isCPU))
  ) {
    data.firing = state;

    if (!data.isCPU) {
      // start or stop immediately, too.
      data.fireFrameCount = 0;
    }
  } else {
    data.firing = false;
  }
  // ensure that if false (and CPU), firing rate is reset.
  if (data.isCPU && !data.firing) {
    setCPUFiringRate(exports);
  }
}

function setBombing(exports, state) {
  let { data } = exports;

  // TODO: review forcing of false when `.onLandingPad` vs. next block, DRY etc.

  // no matter what, bail if on a landing pad.
  if (data.onLandingPad) {
    data.bombing = false;
    return;
  }

  if (state !== undefined && (!data.onLandingPad || (!state && data.isCPU))) {
    data.bombing = !!state;

    if (!data.isCPU) {
      // start or stop immediately, too.
      data.bombFrameCount = 0;
    }
  }
  // ensure that if false (and CPU), bombing rate is reset.
  if (data.isCPU && !data.bombing) {
    setCPUBombingRate(exports);
  }
}

function setMissileLaunching(exports, state, missileModeFromNetwork) {
  let { data } = exports;

  // special override from remote, so we can fire the same type
  if (missileModeFromNetwork) {
    data.missileMode = missileModeFromNetwork;
  }

  data.missileLaunching = state;

  if (!data.isCPU) {
    // note the "time", for immediate "denied" sound feedback.
    data.missileLaunchingFrameCount = parseInt(
      data.missileLaunchingModulus,
      10
    );
  }
}

function setParachuting(exports, state) {
  let { data } = exports;

  data.parachuting = state;

  // start or stop immediately, too.
  data.parachuteFrameCount = parseInt(data.parachuteModulus, 10);
}

function setRespawning(exports, state) {
  let { data, radarItem, timers } = exports;

  const force = true;

  data.respawning = state;

  const respawnY = data.yMax - data.yMaxOffset;

  if (state) {
    moveTo(exports, common.getLandingPadOffsetX(exports), respawnY);

    // assign landing pad object
    const pads = game.objects[TYPES.landingPad];
    const landingPad = pads[data.isEnemy ? pads.length - 1 : 0];

    data.landingPad = landingPad.data.id;

    if (data.isLocal) {
      // "get to the choppa!" (center the view on it, that is.)
      game.objects.view.setLeftScrollToPlayer(exports);
    } else {
      // hackish: force enemy helicopter to be on-screen when respawning
      sprites.updateIsOnScreen(exports, force);
    }

    // hackish: force-refresh, so helicopter can be hit while respawning.
    zones.refreshZone(exports);

    // look ma, no longer dead!
    data.dead = false;
    data.pilot = true;
    data.deployedParachute = false;
    data.excludeFromCollision = false;

    // used by CPU to determine default heading
    data.defaultDirection = true;

    radarItem?.reset();
    radarItem?.summon();

    if (data.isLocal) {
      // reset everything.
      updateStatusUI(exports, { force: true });
      updateLives(exports);
    }

    sprites.updateEnergy(data.id);

    // ensure we're visible.
    data.visible = true;
  }

  if (state) {
    // notify local human, only.
    if (common.playerCanLoseLives(data) && data.lives === 0) {
      const warning =
        '<span class="inline-emoji" style="animation: blink 0.5s infinite">⚠️</span>';
      game.objects.view.setAnnouncement(
        `${warning} Last helicopter ${warning}`
      );
      let buyMore = clientFeatures.keyboard
        ? '\n<u>H</u> to order more, 20 funds ea.'
        : ' Extra chopper = 20 funds.';
      game.objects.notifications.addNoRepeat(
        `WARNING: Last helicopter! 🚁${buyMore}`
      );
    }

    // "complete" respawn, re-enable mouse etc.
    timers.respawnCompleteTimer = common.setFrameTimeout(
      () => respawnComplete(exports),
      1500
    );
  }
}

function respawnComplete(exports) {
  let { data } = exports;

  data.respawnCompleteTimer?.reset();
  data.respawnCompleteTimer = null;
  callAction(exports, 'setRespawning', false);

  if (data.isCPU) {
    data.ai?.resetSineWave(data);
  }
}

function flip(exports, force) {
  let { data, spriteConfig } = exports;

  // flip the helicopter so it's pointing R-L instead of the default R/L (toggle behaviour)

  // if not dead or landed, that is.
  if (
    !force &&
    (data.respawning ||
      data.landed ||
      data.onLandingPad ||
      data.dead ||
      data.y <= 0)
  )
    return;

  data.flipped = !data.flipped;

  // TODO: yuck. refactor.
  spriteConfig.rotating.animationConfig.reverseDirection =
    (data.isEnemy && data.flipped) || (!data.isEnemy && !data.flipped);

  swapSprite(exports, spriteConfig.rotating);

  // immediately re-scan for new missile targets.
  if (data.isLocal) {
    scanRadar(exports);
  }

  if (data.isLocal && !data.autoFlip && sounds.helicopter.flip) {
    playSound(sounds.helicopter.flip);
  }

  /**
   * Mobile clients auto-flip the local player, but should send
   * these events to the remote (e.g., a desktop) for consistency.
   */
  if (net.active && data.isLocal) {
    net.sendMessage({ type: 'GAME_EVENT', id: data.id, method: 'flip' });
  }
}

function toggleAutoFlip(exports) {
  let { data } = exports;

  // special case: if on landing pad, flip muzak pref.
  if (game?.players?.local?.data?.onLandingPad) {
    const pref = 'muzak';
    if (data.onLandingPad && data.isLocal) {
      // flip
      prefsManager.applyNewPrefs({ [pref]: !gamePrefs[pref] });
      game.objects.notifications.addNoRepeat(
        `📻 Muzak switched ${gamePrefs[pref] ? 'on' : 'off'}.`
      );
      if (gamePrefs[pref]) {
        const force = true;
        maybeStartRepairingMedia(exports, force);
      } else {
        stopRepairingMedia(exports);
      }
      return;
    }
  }

  // revert to normal setting
  if (data.flipped) flip(exports);

  // toggle auto-flip
  data.autoFlip = !data.autoFlip;

  if (data.isLocal) {
    game.objects.notifications.add(
      data.autoFlip
        ? 'Auto-flip enabled'
        : clientFeatures.touch
          ? 'Auto-flip disabled.\nTap with another finger to flip manually.'
          : 'Auto-flip disabled'
    );

    // TODO: better "confirmation" sound
    if (sounds.inventory.begin) {
      playSound(sounds.inventory.begin);
    }

    // update the pref, and store.
    gamePrefs.auto_flip = data.autoFlip;
    utils.storage.set('auto_flip', data.autoFlip ? 1 : 0);
  }

  // network: replicate this on the other end.
  if (net.active && data.isLocal) {
    net.sendMessage({
      type: 'GAME_EVENT',
      id: data.id,
      method: 'toggleAutoFlip'
    });
  }
}

function applyTilt(exports) {
  let { data } = exports;

  if (data.energy <= data.shakeThreshold) {
    data.shakeOffset =
      rnd(1) *
      (data.shakeOffsetMax *
        ((data.shakeThreshold - data.energy) / data.shakeThreshold) *
        plusMinus());
  } else {
    data.shakeOffset = 0;
  }

  // L -> R / R -> L + forward / backward

  // auto-flip (rotate) feature
  if (!data.landed && data.autoFlip) {
    if (!data.isEnemy) {
      if (
        (data.vX > data.autoFlipThreshold && data.flipped) ||
        (data.vX < -data.autoFlipThreshold && !data.flipped)
      ) {
        flip(exports);
      }
    } else if (
      (data.vX > data.autoFlipThreshold && !data.flipped) ||
      (data.vX < -data.autoFlipThreshold && data.flipped)
    ) {
      flip(exports);
    }
  }

  data.tiltOffset =
    data.dead || data.respawning || data.landed || data.onLandingPad
      ? 0
      : (data.vX / data.vXMax / 0.6) * 10 + data.shakeOffset;

  // to be rendered via domCanvas
  data.angle = data.tiltOffset;
}

function onLandingPad(exports, state, pad = null) {
  let { data } = exports;

  if (data.dead) {
    // ensure repair is canceled, if underway
    if (data.repairing) {
      stopRepairing(exports);
      stopRepairingMedia(exports);
    }

    return;
  }

  // our work may already be done.
  if (data.onLandingPad === state && data.landed === state) return;

  data.onLandingPad = state;
  data.landed = state;

  // assign the active landing pad, by ID.
  data.landingPad = pad;

  // edge case: helicopter is "live", but not active yet.
  if (data.respawning) return;

  if (state) {
    maybeRumbleOnLanding(exports);

    data.vX = 0;
    data.vY = 0;

    moveTo(exports, data.x, data.y);

    // edge case: stop firing, etc.
    callAction(exports, 'setFiring', false);
    callAction(exports, 'setBombing', false);

    startRepairing(exports);
  } else {
    stopRepairing(exports);
    stopRepairingMedia(exports);

    // only allow repair, etc., once hasLiftOff has been set.
    data.hasLiftOff = true;
  }
}

function refreshCoords(exports) {
  let { data } = exports;

  const { view } = game.objects;

  let landscapeDetail;

  // roughly accurate for iPhone X, 01/2018.
  const notchWidth = 50;

  // determine max X and Y coords

  // "whole world", plus a bit; this allows the chopper to go a bit beyond the end bunker.
  data.xMax = view.data.battleField.width + worldOverflow;

  // including border
  data.yMax = view.data.world.height - data.height - data.yMaxOffset;

  // if mobile, set xMin and mobileControlsWidth (referenced in animate()) to prevent chopper flying over/under mobile controls.
  if (isMobile) {
    // account for mobile controls, if in landscape mode.
    landscapeDetail = getLandscapeLayout();

    if (landscapeDetail) {
      // slight offsets, allow helicopter to be very close to controls.
      // some affordance for The Notch, on iPhone (just assume for now, because FFS.)
      data.xMaxOffset =
        isiPhone && landscapeDetail === 'right' ? notchWidth : 0;
      data.xMin = isiPhone && landscapeDetail === 'left' ? notchWidth : 0;
    } else {
      // portrait mode: just forget it altogether and let helicopter go atop controls.
      // compensate for half of helicopter width being subtracted, too.
      data.xMaxOffset = -data.width * 0.5;
      data.xMin = -data.width * 0.5;
    }
  }

  // limit the helicopter to the top of the stats bar UI.
  const statsBar = document.getElementById('stats-bar');
  const rect = statsBar.getBoundingClientRect();
  data.yMin = rect.top * (1 / screenScale);
}

function moveToForReal(exports, x, y) {
  let { data } = exports;

  const yMax = data.yMax - (data.repairing ? 3 : 0);

  // Hack: limit enemy helicopter to visible screen
  if (data.isCPU) {
    x = Math.min(worldWidth + worldOverflow, Math.max(0, x));
  }

  if (x !== undefined) {
    x = Math.min(data.xMax, x);
    if (x && data.x !== x) {
      data.x = x;
      data.midPoint.x = data.x + data.halfWidth;
    }
  }

  if (y !== undefined) {
    y = Math.max(data.yMin, Math.min(yMax, y));
    if (data.y !== y) {
      data.y = y;
      // TODO: redundant?
      data.midPoint.y = data.y;
    }
  }

  // reset angle if we're landed.
  if (y >= yMax) {
    data.tiltOffset = 0;
  }

  applyTilt(exports);

  zones.refreshZone(exports);
}

function moveTo(exports, x, y) {
  let { data } = exports;

  if (net.active && data.isRemote && data.dead) return;

  // Note: this updates data.x + data.y.
  moveToForReal(exports, x, y);

  // Note: CPU may also be local, which is why we don't exit early above.
  if (net.active && data.isCPU && !data.isRemote) {
    // immediately send our data abroad...
    game.objects.view.sendPlayerCoordinates(exports);
  }
}

function moveTrailers(exports) {
  let { data } = exports;

  // don't show if dead, or being "summoned" (respawning) via stepOffset
  if (!data.isOnScreen || data.dead || data.stepOffset < 1) return;

  common.domCanvas.drawTrailers(
    exports,
    data.xHistory,
    data.yHistory,
    0,
    data.halfHeightAdjusted
  );
}

function reset(exports) {
  let { data } = exports;

  let i, j, k, l, items, xLookAhead, foundObject, types, landingPad, noEntry;

  const pads = game.objects[TYPES.landingPad];

  landingPad = pads[data.isEnemy ? pads.length - 1 : 0];

  /**
   * Determine if there is an enemy on, or about to be on the landing pad.
   * If so, repeat in a moment to avoid the copter dying immediately.
   *
   * This can happen when you have a convoy of tanks near the enemy base -
   * the enemy chopper can respawn each time a tank is over it. :(
   */

  types = getTypes('missileLauncher, tank, van, infantry', { exports });
  xLookAhead = 0;

  // is there a "foreign" object on, or over the base that would collide?
  for (i = 0, j = types.length; i < j; i++) {
    // chopper is vulnerable if opponent is at their base
    items = game.objects[types[i].type];
    for (k = 0, l = items.length; k < l; k++) {
      if (
        items[k].data.isEnemy !== data.isEnemy &&
        collisionCheck(items[k].data, landingPad.data, xLookAhead)
      ) {
        foundObject = items[k];
        break;
      }
    }
  }

  // something is covering the landing pad - retry shortly.
  if (foundObject) {
    if (data.isLocal) {
      noEntry =
        '<span class="inline-emoji" style="animation: blink 0.5s infinite">⛔</span>';
      game.objects.view.setAnnouncement(
        `${noEntry} Landing pad obstructed.\nWaiting for clearance. ${noEntry}`
      );
    }

    common.setFrameTimeout(() => reset(exports), 500);

    return;
  } else {
    // finally, bring 'er up.
    resetAndRespawn(exports);
  }
}

function resetAndRespawn(exports) {
  let { data } = exports;

  // bail if game over (local human, only.)
  if (data.lives < 0 && common.playerCanLoseLives(data)) return;

  data.fuel = data.maxFuel;
  data.energy = data.energyMax;
  data.parachutes = data.isCPU
    ? parseInt(data.maxParachutes, 10)
    : tutorialMode
      ? 1
      : 0;
  data.smartMissiles = data.maxSmartMissiles;
  data.ammo = data.maxAmmo;
  data.bombs = data.maxBombs;

  // various landed / repaired state
  data.landed = true;
  data.onLandingPad = true;
  data.repairComplete = false;
  data.hasLiftOff = false;

  data.vX = 0;
  data.vY = 0;

  data.attacker = undefined;

  if (!data.isCPU) {
    if (!tutorialMode) {
      game.objects.view.clearAnnouncement();
    }

    if (sounds.helicopter.engine?.sound)
      sounds.helicopter.engine.sound.setVolume(
        sounds.helicopter.engineVolume * gamePrefs.volume
      );
  } else {
    if (data.flipped) {
      flip(exports);
    }
  }

  // reset any queued firing actions
  data.bombing = false;
  data.firing = false;
  data.missileLaunching = false;
  data.parachuting = false;
  data.shakeOffset = 0;

  data.exploding = false;

  // reposition on appropriate landing pad
  data.x = common.getLandingPadOffsetX(exports);
  data.y = worldHeight - data.height;

  // ensure tilt angle is reset to 0
  applyTilt(exports);

  // move to landing pad
  moveTo(exports, data.x, data.y);

  // data.dead and other bits will be set with respawn action
  callAction(exports, 'setRespawning', true);
}

function respawn(exports) {
  // exit if game is over.
  if (game.data.battleOver) return;

  // helicopter died. move view, and reset.
  reset(exports);
}

function shouldDelayRespawn() {
  /**
   * Special case: if a non-network game and a "fire" key is held down,
   * delay the respawn. This was in the original game as a feature
   * where you could continue to watch the scene where you died.
   */

  return (
    !net.active &&
    (keyboardMonitor.isDown('shift') ||
      keyboardMonitor.isDown('ctrl') ||
      keyboardMonitor.isDown('x') ||
      keyboardMonitor.isDown('z'))
  );
}

function localReset(exports, noDelay) {
  let { data } = exports;

  let respawnDelay = getRespawnDelay(exports);

  let halfRespawn = respawnDelay / 2;

  // this should not take priority, e.g., if the game-over sequence is running.
  let override = false;

  // enough time to get back to base before helicopter has fully respawned.
  let scrollDuration = 4;

  // start animation after a delay...
  let delay = noDelay ? 1 : halfRespawn;

  common.setFrameTimeout(() => {
    if (shouldDelayRespawn()) {
      /**
       * Check again in a moment, but don't wait - once key is released,
       * response should be immediate.
       */
      window.requestAnimationFrame(() => localReset(exports, true));
      return;
    }

    // guard against resetting scroll during battle-over sequence
    if (game.data.battleOver) return;

    game.objects.view.animateLeftScrollTo(
      common.getLandingPadOffsetX(exports) +
        data.halfWidth -
        game.objects.view.data.browser.halfWidth,
      override,
      scrollDuration
    );

    // start proper respawn by the time the view has scrolled back to the base.
    common.setFrameTimeout(() => respawn(exports), halfRespawn);
  }, delay);
}

function die(exports, dieOptions = {}) {
  let { data, radarItem } = exports;

  if (data.dead) return;

  data.livesLost++;

  data.respawnCompleteTimer?.reset();
  data.respawnCompleteTimer = null;

  // reset animations
  data.frameCount = 0;

  data.exploding = true;

  // drop this state in a moment.
  common.setFixedFrameTimeout(() => (data.exploding = false), 2000);

  let attacker = getObjectById(dieOptions.attacker);

  const aData = attacker?.data;

  if (data.isLocal) {
    dropMissileTargets(exports);
    reactToDamage(exports, attacker);
    // slow down and stop the battlefield scroll, if any.
    game.objects.view.decelerateScroll();
  }

  if (
    attacker &&
    (aData.type === TYPES.helicopter ||
      aData.type === TYPES.smartMissile ||
      (aData.type === TYPES.gunfire && aData.parentType === TYPES.turret))
  ) {
    // hit by other helicopter, missile, or turret gunfire? big smoke ring.
    effects.smokeRing(data.id, {
      count: 20,
      velocityMax: 20,
      offsetY: data.height - 2,
      isGroundUnit: data.landed || data.onLandingPad || data.bottomAligned,
      parentVX: data.vX,
      parentVY: data.vY
    });

    // special check: friendly turret shot down enemy helicopter
    if (
      gamePrefs.bnb &&
      data.isEnemy !== game.players.local.data.isEnemy &&
      aData?.parentType === TYPES.turret &&
      sounds?.bnb?.cornholioAttack
    ) {
      common.setFrameTimeout(() => {
        if (data.dead) return;
        playSound(sounds.bnb.cornholioAttack, attacker, {
          onplay: () =>
            game.objects.notifications.add(
              `The enemy was shot down by ${
                Math.random() >= 0.5
                  ? 'THE GREAT CORNHOLIO.'
                  : 'THE ALMIGHTY BUNGHOLE.'
              }`,
              { noRepeat: true }
            )
        });
      }, 1000);
    }
  }

  // extra-special case: player + enemy helicopters collided.
  if (attacker) {
    if (aData.type === TYPES.helicopter) {
      if (!aData.isEnemy) gameEvents.fire(EVENTS.helicopterCollision);
    } else if (data.isEnemy && aData) {
      /**
       * Celebrate the win if you, or certain actors take out an enemy
       * chopper while on-screen.
       */
      //
      if (
        data.isOnScreen &&
        (aData.parentType === TYPES.helicopter ||
          aData.type === TYPES.smartMissile ||
          aData.type === TYPES.balloon)
      ) {
        gameEvents.fire(EVENTS.enemyDied);
      }
    } else {
      // local player, generic: "you died"
      gameEvents.fire(EVENTS.youDied, 'attacker', attacker);
    }
  } else {
    // local player, generic: "you died" - no attacker
    gameEvents.fire(EVENTS.youDied);
  }

  effects.shrapnelExplosion(data, {
    count: 20 + (net.active ? 0 : rngInt(20, TYPES.shrapnel)),
    velocity: 4 + rngInt(4, TYPES.shrapnel),
    vX: data.vX,
    vY: -Math.abs(data.vY),
    // special case: if a smart missile, use its velocity for shrapnel.
    parentVX:
      attacker && aData?.type === TYPES.smartMissile
        ? aData.vX || data.vX
        : data.vX,
    parentVY: -Math.abs(data.vY),
    // first burst always looks too similar, here.
    noInitialSmoke: true
  });

  //

  effects.smokeRing(data.id, { parentVX: data.vX, parentVY: data.vY });

  effects.inertGunfireExplosion({ exports, count: 8 + rndInt(8) });

  // roll the dice: drop a paratrooper (pilot ejects safely)
  // skipping this for network games, risk of de-sync - needs troubleshooting.
  if (
    !net.active &&
    ((data.isCPU &&
      (!tutorialMode && gameType !== 'easy'
        ? aiRNG(exports) > 0.5
        : aiRNG(exports) > 0.25)) ||
      (data.isLocal && rng(1, data.type) > 0.66))
  ) {
    data.deployedParachute = true;
    deployParachuteInfantry({
      parent: data.id,
      isEnemy: data.isEnemy,
      x: data.x + data.halfWidth,
      y: data.y + data.height - 11,
      ignoreShrapnel: true
    });
  }

  common.setFrameTimeout(() => {
    // undo flip
    if (data.flipped) {
      flip(exports, true);
    }
  }, 1500);

  data.energy = 0;

  // ensure any health bar is updated and hidden ASAP
  sprites.updateEnergy(data.id);

  // there may be no attacker if, e.g., we crashed into the ground.
  effects.domFetti(data.id, attacker?.data?.id);

  // randomize for next time
  data.domFetti.elementCount = 256 + rndInt(512);
  data.domFetti.startVelocity = 15 + rndInt(32);

  // move sprite once explosion stuff has completed
  common.setFrameTimeout(() => {
    // ignore if the game has ended.
    if (game.data.battleOver) return;

    // reposition on appropriate landing pad
    data.x = common.getLandingPadOffsetX(exports);
    data.y = worldHeight - data.height;

    // move to landing pad before respawn
    moveTo(exports, data.x, data.y);

    // important: make sure the remote gets this before respawn, too.
    if (net.active && data.isLocal) {
      game.objects.view.sendPlayerCoordinates(exports);
    }
  }, 2000);

  data.dead = true;

  data.dieCount++;

  radarItem.die();

  data.visible = false;

  if (sounds.explosionLarge) {
    playSound(sounds.explosionLarge, exports);
    if (sounds.genericExplosion) playSound(sounds.genericExplosion, exports);
  }

  if (data.isLocal && sounds.helicopter.engine) {
    if (sounds.helicopter.engine.sound)
      sounds.helicopter.engine.sound.setVolume(0);
  }

  common.onDie(data.id, dieOptions);

  if (!data.deployedParachute) {
    common.addGravestone(exports);
  }

  // Local, human player only
  if (common.playerCanLoseLives(data)) {
    data.lives--;
    if (data.lives < 0) {
      // game over.
      game.objects.view.setAnnouncement(
        'Game over! <span class="inline-emoji">☠️&hairsp;🏳️</span> &hairsp;Better luck next time.<hr />' +
          getDefeatMessage(),
        -1
      );

      game.objects.notifications.add(
        'Game over. <span class="no-emoji-substitution">☠️</span> 🏳️'
      );

      game.data.battleOver = true;
      game.data.youWon = false;
      game.data.theyWon = true;
      game.data.didEnemyWin = true;

      // ensure joystick UI is hidden, if present
      game.objects.joystick?.stop();

      game.logEvent('GAME_OVER');

      utils.css.add(document.body, 'game-over', 'you-lost');
    }
  }

  // don't respawn the enemy (CPU) chopper during tutorial mode.
  if ((!tutorialMode || !data.isEnemy) && !game.data.battleOver) {
    if (data.isLocal) {
      // animate back to home base.
      localReset(exports);
    } else {
      // by the time the above is almost finished, start proper respawn.
      common.setFrameTimeout(() => respawn(exports), getRespawnDelay(exports));
    }
  }
}

function getRespawnDelay(exports) {
  // delay at least 1 second, to prevent an infinite explosion / respawn loop
  return Math.max(
    1000,
    (exports.data.isCPU ? levelConfig.regenTimeI : 48) * 100
  );
}

let verticalBombTypes = {
  // allow CPU to drop closer to vX = 0, for "accuracy"
  [TYPES.turret]: true,
  [TYPES.infantry]: true,
  [TYPES.engineer]: true
};

function getBombParams(exports) {
  let { data } = exports;

  let vX = data.vX;

  // CPU advantage: subtract some of the difference between CPU and target vX.
  if (data.isCPU && data.bombTargets?.[0]) {
    // give CPU more of an edge, depending on difficulty.
    let bombAccuracy =
      gameType === 'extreme' || gameType === 'armorgeddon'
        ? 2
        : gameType === 'hard'
          ? 3
          : 6;
    if (verticalBombTypes[data.bombTargets[0].type]) {
      // "cheat" and bomb much more vertically.
      vX = data.vX * 0.125;
    } else {
      // compensate somewhat for target vX.
      vX -= (vX - (data.bombTargets[0].vX || 0)) / bombAccuracy;
    }
  }

  return {
    parent: data.id,
    parentType: data.type,
    isEnemy: data.isEnemy,
    x: data.x + data.halfWidth,
    y: data.y + data.height - 6,
    vX,
    vY: data.vY,
    napalm: levelFlags.napalm
  };
}

function getAimedMissileParams(exports) {
  let { data } = exports;

  let vX, vXDirection;

  // ensure bullets fire and move away from the chopper.
  const flipped = !!data.flipped;

  if (!data.isEnemy) {
    if (data.vX < 0) {
      // flying backward
      if (!data.flipped) {
        // facing right
        vX = data.vX * 0.25;
        vXDirection = 1;
      } else {
        // facing left
        vX = data.vX * 0.75;
        vXDirection = -1;
      }
    } else {
      // flying forward
      if (data.flipped) {
        // facing left
        vX = data.vX * 0.25;
        vXDirection = -1;
      } else {
        // facing right
        vX = data.vX * 0.75;
        vXDirection = 1;
      }
    }
  } else {
    if (data.vX < 0) {
      // flying forward
      if (!data.flipped) {
        // facing left
        vX = data.vX * 0.75;
        vXDirection = -1;
      } else {
        // facing right
        vX = data.vX * 0.25;
        vXDirection = 1;
      }
    } else {
      // flying backward
      if (!data.flipped) {
        // facing left
        vX = data.vX * 0.25;
        vXDirection = -1;
      } else {
        // facing right
        vX = data.vX * 0.75;
        vXDirection = 1;
      }
    }
  }

  return {
    parent: data.id,
    parentType: data.type,
    isEnemy: data.isEnemy,
    x:
      data.x +
      ((!data.isEnemy && data.flipped) || (data.isEnemy && !data.flipped)
        ? 0
        : data.width - 8),
    y:
      data.y +
      data.halfHeight +
      // don't apply tilt when CPU has an "obstacle" object.
      (data.tilt !== null && (!data.isCPU || !data.obstacle)
        ? tiltOffset + 2
        : 0) +
      (data.isEnemy ? 2 : 0),
    vX,
    vXDirection
  };
}

function getGunfireParams(exports) {
  let { data } = exports;

  let tiltOffset =
    data.tiltOffset !== 0
      ? data.tiltOffset * data.tiltYOffset * (data.flipped ? -1 : 1)
      : 0;

  let vX, vY, x, y;

  // inherent speed of a bullet
  const bulletVX = 7;

  // limit how much bullets can be "thrown"

  let xMax = !data.isCPU
    ? data.vXMax
    : data.useClippedSpeed && !data.targeting.retaliation
      ? data.vXMaxClipped / 2
      : data.vXMax / 2;

  const bulletVXMax = xMax + bulletVX / 1.5;

  // ensure bullets fire and move away from the chopper.
  const flipped = !!data.flipped;

  x =
    data.x +
    ((!data.isEnemy && data.flipped) || (data.isEnemy && !data.flipped)
      ? 0
      : data.width - 8);

  y =
    data.y +
    data.halfHeight +
    (data.tilt !== null ? tiltOffset + 2 : 0) +
    (data.isEnemy ? 2 : 0);

  if ((!data.isEnemy && flipped) || (data.isEnemy && !flipped)) {
    // -ve: ensure bullets go left
    vX = Math.max(-bulletVXMax, Math.min(-bulletVX, data.vX - bulletVX));
  } else {
    // +ve: ensure bullets go right
    vX = Math.min(bulletVXMax, Math.max(bulletVX, bulletVX + data.vX));
  }

  vY = data.vY + tiltOffset * (data.isEnemy ? -1 : 1);

  // TODO: implement data.ammoTarget for network games
  if (
    (gamePrefs.gamepad && gamepad.data.active && gamepad.data.state.isFiring) ||
    (data.isCPU && !net.active)
  ) {
    // aim for data.ammoTarget
    let target;

    if (data.isCPU) {
      target = data.ammoTarget;
    } else if (data.y < 330) {
      // airborne human player, not landed nor too close to ground.
      // HACK: "soft auto-targeting" for human players using gamepads.
      let types = [TYPES.balloon, TYPES.helicopter, TYPES.smartMissile];

      let nearbyThreats = findEnemy(data, types, 192);

      target = nearbyThreats[0];

      if (target) {
        // ignore targets that would make gunfire movement look unrealistically wacky.
        if (target.data && Math.abs(target.data.y - data.y) > 24) {
          target = null;
        } else {
          // hackish: make target the data structure, as ammoTarget normally expects.
          target = target.data;
        }
      }
    }

    if (target) {
      // HACK: Note target is the data structure. :X
      let ammoTarget = new Vector(target.x, target.y);

      let pos = new Vector(data.x, data.y);

      let velocity = new Vector(target.vX, target.vY);

      /**
       * NOTE: inverting velocity on the target, because seek expects
       * velocity of the chopper chasing the target.
       */
      velocity.mult(-1);

      /**
       * this magnitude works OK for targeting balloons on chains,
       * and the human chopper.
       */
      velocity.setMag(1);

      let seekForce = seek(ammoTarget, pos, velocity, data.vXMax, data.vXMax);

      // approximation of max bullet speed.
      // CPU might have a *slight* advantage in bullet velocity, here.
      if (data.isCPU) {
        seekForce.setMag(xMax * 2.5);
      }

      vX = seekForce.x;
      vY = seekForce.y;
    }
  }

  const damagePoints = 2;

  return {
    parent: data.id,
    parentType: data.type,
    isEnemy: data.isEnemy,
    x,
    y,
    vX,
    vY,
    damagePoints
  };
}

function getSmartMissileParams(exports, missileTarget) {
  let { data } = exports;

  // remote helicopters have missile mode set via network.
  const missileModeSource =
    (data.isRemote ? data.missileMode : game.objects.view.data.missileMode) ||
    defaultMissileMode;

  return {
    parent: data.id,
    parentType: data.type,
    isEnemy: data.isEnemy,
    x:
      data.x +
      (data.isEnemy
        ? (data.flipped ? data.width : 0) - 8
        : (data.flipped ? 0 : data.width) - 8),
    y: data.y + data.halfHeight, // + (data.tilt !== null ? tiltOffset + 2 : 0),
    target: missileTarget,
    // special variants of the smart missile. ;)
    isBanana: missileModeSource === bananaMode,
    isRubberChicken: missileModeSource === rubberChickenMode,
    isSmartMissile: missileModeSource === defaultMissileMode,
    onDie: () => maybeDisableTargetUI(exports)
  };
}

function maybeDisableTargetUI(exports) {
  let { data } = exports;

  // this applies only to the local player.
  if (!data.isLocal) return;

  if (data.smartMissiles) return;

  const activeMissiles = game.objects[TYPES.smartMissile].filter(
    (m) => !m.data.dead && m.data.parent === game.players.local.data.id
  );

  // bail if there are still missiles in the air.
  if (activeMissiles.length) return;

  game.objects.radar.clearTarget();
}

function dropMissileTargets(exports) {
  let { lastMissileTarget, nextMissileTarget } = exports;

  dropNextTarget(exports);

  if (nextMissileTarget) {
    markTarget(exports, nextMissileTarget);
  }
  if (lastMissileTarget) {
    markTarget(exports, lastMissileTarget);
  }
  game.objects.radar.clearTarget();
}

function dropNextTarget(exports) {
  let { nextMissileTarget } = exports;

  if (!nextMissileTarget) return;

  let oTarget = getObjectById(nextMissileTarget);

  // unmark the target object, if it still exists
  if (oTarget) {
    oTarget.data.isNextMissileTarget = false;
  }

  exports.nextMissileTarget = null;
}

function markTarget(exports, targetID, active) {
  let { data } = exports;

  if (!data.isLocal) return;

  if (!targetID) return;

  // hackish: force-disable if pref is off.
  if (!gamePrefs.modern_smart_missiles) {
    active = false;
  }

  dropNextTarget(exports);

  // TODO: refactor or drop when 100% on canvas.

  let target = getObjectById(targetID);

  // target may have been destroyed.
  if (target) {
    target.data.isNextMissileTarget = !!active;
  }

  // new target
  if (active && target) {
    exports.nextMissileTarget = targetID;
    game.objects.radar.markTarget(target.radarItem);
  }

  // inactive, OR, destroyed target
  if (!active || !target) {
    exports.nextMissileTarget = null;
    if (data.isLocal) {
      game.objects.radar.clearTarget();
    }
  }
}

function scanRadar(exports) {
  let { data, lastMissileTarget } = exports;

  // don't update if there are no missiles.
  // this helps to preserve the last target if the last missile was just fired.
  if (!data.smartMissiles) {
    dropNextTarget(exports);
    return;
  }

  const newTarget = getNearestObject(exports, {
    useInFront: true,
    ignoreIntersect: true
  });

  if (newTarget && newTarget !== lastMissileTarget) {
    markTarget(exports, lastMissileTarget, false);

    markTarget(exports, newTarget, true);

    exports.lastMissileTarget = newTarget;
  } else if (!newTarget && lastMissileTarget) {
    markTarget(exports, lastMissileTarget, false);

    exports.lastMissileTarget = null;
  }
}

function updateMissileUI(exports, reloading) {
  let { dom, css } = exports;

  // Yuck. TODO: DRY.
  if (dom.statusBar?.missileCountLI) {
    utils.css.addOrRemove(
      dom.statusBar.missileCountLI,
      reloading,
      css.reloading
    );
  }

  utils.css.addOrRemove(
    document.querySelectorAll(
      '#mobile-controls .mobile-controls-weapons li'
    )[2],
    reloading,
    css.reloading
  );
}

function fire(exports) {
  let { data, lastMissileTarget, timers } = exports;

  let missileTarget;
  const updated = {};

  if (
    !data.firing &&
    !data.bombing &&
    !data.missileLaunching &&
    !data.parachuting
  )
    return;

  if (data.firing && !data.fireFrameCount) {
    data.fireFrameCount = parseInt(data.fireModulus, 10);
    if (data.ammo > 0) {
      if (levelFlags.bullets) {
        /**
         * Account somewhat for helicopter angle, including tilt from flying
         * and random "shake" from damage.
         */
        let params = getGunfireParams(exports);

        game.addObject(TYPES.gunfire, params);

        playSound(
          data.isEnemy ? sounds.machineGunFireEnemy : sounds.machineGunFire,
          exports
        );
      } else {
        // CPU case: ensure facing target
        if (data.isCPU && !data.isRemote && data.ammoTarget) {
          checkFacingTarget(exports, { data: data.ammoTarget });
        }
        let params = getAimedMissileParams(exports);

        game.addObject(TYPES.aimedMissile, params);
      }

      data.ammo = Math.max(0, data.ammo - 1);

      if (data.isLocal) {
        updated.ammo = true;
      }
    } else {
      // special case: allow CPU to fire smart missiles in some cases
      if (data.isCPU && !data.isRemote) {
        data.ai?.maybeRetaliateWithSmartMissile?.();
      }
      if (data.isLocal && sounds.inventory.denied) {
        // player is out of ammo.
        playSound(sounds.inventory.denied);
      }
    }

    // SHIFT key still down?
    if (data.isLocal && !keyboardMonitor.isDown('shift')) {
      if (data.firing) callAction(exports, 'setFiring', false);
    }
  }

  if (data.fireFrameCount) {
    data.fireFrameCount--;
  }

  if (data.bombing && !data.bombFrameCount) {
    data.bombFrameCount = parseInt(data.bombModulus, 10);
    if (data.bombs > 0) {
      let params = getBombParams(exports);

      /**
       * "AI" case: throttle bombing by target type; e.g., tanks get
       * up to 3 bombs dropped at once. Intent: optimize the chance of
       * taking out the target, while also not wasting bombs.
       */
      if (data.isCPU && data.ai && data.bombTargets?.[0]) {
        // HACK: re-define data.bombTargets[0] object, flattened for sorting.
        let bombTarget = { data: data.bombTargets[0] };

        // exit if already at limit.
        if (!data.ai.canBombTarget(bombTarget)) return;

        // count toward the limit.
        data.ai.addBomb(bombTarget);

        // when bomb dies, track hit/miss, and whether the target died.
        params.onDie = function (bombExports, bombDieOptions) {
          /**
           * Remove (decrement) if the target was not hit.
           * Bomb may not have a target if it hit the ground, etc.
           */
          let didHitTarget =
            bombDieOptions?.target?.data?.id === bombTarget.data.id;

          if (didHitTarget) {
            /**
             * Reset tracking after a delay (so more can be dropped),
             * in case the target is still alive.
             */
            data.ai.clearBombWithDelay(bombTarget);
          }

          // clear entirely if target is dead.
          if (bombTarget.data.dead) {
            data.ai.removeBomb(bombTarget);
            // reset state
            data.ai.clearBombWithDelay(bombTarget);
          } else if (!didHitTarget) {
            // target is still live, bomb missed; try another?
            data.ai.removeBomb(bombTarget);
          }
        };
      }

      game.addObject(TYPES.bomb, params);

      if (sounds.bombHatch) {
        playSound(sounds.bombHatch, exports);
      }

      data.bombs = Math.max(0, data.bombs - 1);

      if (data.isLocal) {
        updated.bombs = true;
      }
    } else if (data.isLocal && sounds.inventory.denied) {
      // player is out of ammo.
      playSound(sounds.inventory.denied);
    }

    // "bombing" key still down?
    if (
      data.isLocal &&
      !keyboardMonitor.isDown('ctrl') &&
      !keyboardMonitor.isDown('z')
    ) {
      data.bombing = false;
    }
  }

  if (data.bombFrameCount) {
    data.bombFrameCount--;
  }

  if (data.missileLaunching) {
    if (data.smartMissiles > 0) {
      // local chopper may use target from UI
      if (!data.isCPU && data.isLocal && !lastMissileTarget?.data?.dead) {
        missileTarget = lastMissileTarget;
      } else if (data.isCPU && data.ai?.getMissileTarget) {
        missileTarget = data.ai.getMissileTarget();
      } else {
        missileTarget = getNearestObject(exports, { useInFront: true });
      }

      let liveTarget = getObjectById(missileTarget);

      if (
        !data.missileReloading &&
        missileTarget &&
        !liveTarget?.data?.cloaked
      ) {
        // hackish: ensure missileTarget param is an ID, string.
        const params = getSmartMissileParams(
          exports,
          missileTarget?.data?.id || missileTarget
        );

        game.addObject(TYPES.smartMissile, params);

        data.smartMissiles = Math.max(0, data.smartMissiles - 1);

        updated.smartMissiles = true;

        data.missileReloading = true;

        updateMissileUI(exports, data.missileReloading);

        // set a timeout for "reloading", delay next missile launch slightly.
        timers.missileReloadingTimer = common.setFrameTimeout(() => {
          data.missileReloading = false;
          updateMissileUI(exports, data.missileReloading);
        }, data.missileReloadingDelay);
      }
    }

    if (
      !data.missileReloading &&
      data.isLocal &&
      (!data.smartMissiles || !missileTarget)
    ) {
      /**
       * Out of ammo / no available targets - and, it's been an interval -
       * OR, the missile key / trigger was just pressed...
       */
      if (
        sounds.inventory.denied &&
        game.objects.gameLoop.data.frameCount %
          parseInt(data.missileLaunchingModulus, 10) ===
          0
      ) {
        playSound(sounds.inventory.denied);
      }

      if (data.smartMissiles && !missileTarget) {
        game.objects.notifications.add('🚀 Missile: No nearby target? 📡 🚫', {
          noRepeat: true
        });
      }
    }
  }

  if (data.missileLaunchingFrameCount) {
    data.missileLaunchingFrameCount--;
  }

  if (data.parachuting) {
    if (data.parachutes > 0 && !data.parachutingThrottle) {
      data.parachutingThrottle = true;

      // set a timeout for "reloading", so the next parachute is not immediate.
      timers.parachutingTimer = common.setFrameTimeout(
        () => {
          data.parachutingThrottle = false;
        },
        (data.landed
          ? data.parachutingDelayLanded
          : data.parachutingDelayFlying) *
          (30 / FPS)
      );

      // helicopter landed? Just create an infantry.
      if (data.landed) {
        game.addObject(TYPES.infantry, {
          isEnemy: data.isEnemy,
          // don't create at half-width, chopper will pick up immediately.
          x: data.x + data.width * (data.isEnemy ? 0.25 : 0.75),
          y: data.y + data.height - 11,
          // exclude from recycle "refund" / reward case
          unassisted: false
        });
      } else {
        deployParachuteInfantry({
          parent: data.id,
          isEnemy: data.isEnemy,
          x: data.x + data.halfWidth,
          y: data.y + data.height - 11
        });
      }

      data.parachutes = Math.max(0, data.parachutes - 1);

      updated.parachutes = true;

      playSound(sounds.popSound2, exports);
    } else if (
      data.isLocal &&
      !data.parachutingThrottle &&
      data.parachuteFrameCount % data.parachuteModulus === 0 &&
      sounds.inventory.denied
    ) {
      if (gamePrefs.bnb && (game.data.isBeavis || game.data.isButthead)) {
        if (!data.bnbNoParachutes) {
          data.bnbNoParachutes = true;
          const { isBeavis } = game.data;
          const playbackRate = isBeavis ? 1 : 0.85 + Math.random() * 0.3;
          playSound(
            isBeavis ? sounds.bnb.beavisGrunt : sounds.bnb.buttheadBelch,
            null,
            {
              playbackRate,
              onfinish: () => (data.bnbNoParachutes = false)
            }
          );
        }
      } else {
        // no more infantry to deploy.
        playSound(sounds.inventory.denied);
      }
    }
  }

  data.parachuteFrameCount++;

  if (
    updated.ammo ||
    updated.bombs ||
    updated.smartMissiles ||
    updated.parachutes
  ) {
    updateStatusUI(exports, updated);
  }
}

function eject(exports) {
  let { data, timers } = exports;

  if (data.landed) {
    game.objects.notifications.addNoRepeat('You cannot eject while landed.');
    playSound(sounds.inventory.denied);
    return;
  }

  /**
   * If on a touch device, require a "double-tap" (at least, while UI is up.)
   * And, notify the first time this happens.
   */
  if (
    data.isLocal &&
    ((gamePrefs.gamepad && gamepad.data.active) || clientFeatures.touch) &&
    !timers.ejectTimer
  ) {
    // mark the first event...
    let oEject = document.getElementById('mobile-eject');
    let ua = 'warning';
    utils.css.add(oEject, ua);
    timers.ejectTimer = common.setFrameTimeout(() => {
      timers.ejectTimer = null;
      utils.css.remove(oEject, ua);
    }, 2000);
    // and notify the first time this happens during this game.
    if (!data.ejectCount) {
      game.objects.notifications.add(
        '⚠️ EJECT: Press again to bail out. 🚁 🪂'
      );
    }
    return;
  }

  // bail!
  if (!data.dead && data.pilot) {
    // always deploy the pilot...
    deployParachuteInfantry({
      isEnemy: data.isEnemy,
      parent: data.id,
      // a little variety
      x:
        data.x +
        data.halfWidth +
        rngPlusMinus(rng(data.halfWidth / 2, data.type), data.type),
      y: data.y + data.height - 11
    });

    // per the original game, always drop a grand total of five.
    const parachutes = 4;

    /**
     * Note that chopper could be dead, or parachutes could be deployed
     * by the time this fires.
     */
    for (let i = 0; i < parachutes; i++) {
      common.setFrameTimeout(
        () => deployRandomParachuteInfantry(exports),
        FPS * (i + 1) * 2
      );
    }

    data.deployedParachute = true;

    data.pilot = false;

    if (!data.isLocal) return;

    if (!tutorialMode) {
      game.objects.view.setAnnouncement(
        'No pilot <span class="inline-emoji">🚁 🪂 😱</span>'
      );
    }

    if (tutorialMode) {
      game.objects.notifications.add(
        'You found the “eject” button. <span class="inline-emoji">😱 💀</span>'
      );
    }

    data.ejectCount++;

    if (gamePrefs.bnb) {
      playSound(
        game.data.isBeavis
          ? sounds.bnb.beavisEjectedHelicopter
          : sounds.bnb.buttheadEjectedHelicopter,
        exports
      );
    }

    if (net.active) {
      // tell the remote.
      net.sendMessage({ type: 'GAME_EVENT', id: data.id, method: 'eject' });
    }
  }
}

function deployRandomParachuteInfantry(exports) {
  let { data } = exports;

  /**
   * Only deploy if not already dead.
   * e.g., helicopter could be ejected, then explode before all infantry
   * have released.
   */
  if (data.dead) return;

  deployParachuteInfantry({
    isEnemy: data.isEnemy,
    parent: data.id,
    // a little variety
    x:
      data.x +
      data.halfWidth +
      rngPlusMinus(rng(data.halfWidth / 2, data.type), data.type),
    y: data.y + data.height - 11
  });

  data.parachutes = Math.max(0, data.parachutes - 1);
}

function deployParachuteInfantry(options) {
  /**
   * Mid-air deployment: check and possibly become the chaff / decoy target
   * for "vulnerable" smart missiles that have just launched, and have not yet
   * locked onto their intended target. In the original game, the enemy chopper
   * would use this trick to distract your missiles.
   */

  game.addObject(TYPES.parachuteInfantry, options);
}

function maybeRumbleOnLanding(exports) {
  let { data, timers } = exports;

  if (!gamePrefs.gamepad || !gamepad.data.active || !data.isLocal || data.isCPU)
    return;
  // feedback: bump the controller relative to chopper's descending velocity.

  // throttle
  if (timers.rumbleTimer) return;

  timers.rumbleTimer = common.setFrameTimeout(
    () => (data.rumbleTimer = null),
    500
  );

  gamepad.rumble(Math.abs(data.vX) / data.vXMax, 50, 'maybeRumbleOnLanding');
}

function animate(exports) {
  let { collision, data, domCanvas, objects } = exports;

  if (game.objects.editor) return;

  /**
   * If local and dead or respawning, send a packet over to keep things going.
   * This is done because coordinates aren't sent while dead, and packets
   * include frame counts. In the case of lock step, this could mean the
   * remote client could freeze while waiting.
   */
  if (net.active && data.isLocal && (data.dead || data.respawning)) {
    net.sendMessage({ type: 'PING' });
  }

  domCanvas.animation?.animate();

  if (data.respawning) return;

  if (game.data.battleOver) return;

  // move according to delta between helicopter x/y and mouse, up to a max.

  let i, j, mouse, jamming, spliceArgs, maxY, yOffset;

  spliceArgs = [i, 1];

  jamming = 0;

  // trailer history
  // push x/y to trailer history arrays, maintain size

  if (data.isOnScreen) {
    // only update every 2 or 4 frames, depending
    if (game.objects.gameLoop.data.frameCount % (FPS === 60 ? 3 : 2) === 0) {
      data.xHistory.push(
        data.x + (data.isEnemy || data.flipped ? data.width : 0)
      );
      data.yHistory.push(data.y);

      if (data.xHistory.length > data.trailerCount + 1) {
        data.xHistory.shift();
        data.yHistory.shift();
      }
    }

    moveTrailers(exports);
  }

  if (data.pilot && data.fuel > 0) {
    /**
     * Mouse data can come from a few sources.
     */
    mouse = data.mouse;

    if (!data.isCPU) {
      // only allow X-axis if not on ground...

      if (isNaN(mouse.x)) {
        console.warn('isNaN(mouse.x) - setting "safe" default');
        mouse.x = 0.5;
      }

      if (isNaN(mouse.y)) {
        console.warn('mouse.y: isNaN - Setting "safe" default');
        mouse.y = 1;
      }

      // mouse coordinates relative to screen dimensions
      let mouseX = mouse.x * game.objects.view.data.browser.width;
      let mouseY = mouse.y * game.objects.view.data.browser.height;

      /**
       * X-velocity is based on mouse position relative to the helicopter.
       * Mouse coordinates are normally based on screen dimensions.
       */

      if (net.active && data.isRemote && !aaLoader.isProd()) {
        common.updateVirtualPointer?.(mouse.x, mouse.y);
      }

      if (!net.active && data.isLocal && !data.isCPU) {
        /**
         * "Fancier" vX movement for local, non-network / non-CPU player
         */

        // the center of the helicopter
        let targetX = data.x + data.halfWidth;

        // the mouse pointer, relative to helicopter with scroll
        let virtualMouseX =
          game.objects.view.data.battleField.scrollLeft + mouseX;

        data.vX =
          ((virtualMouseX - targetX) /
            game.objects.view.data.browser.fractionWidth) *
          data.vXMax;
      } else {
        /**
         * Simplified movement for all in network games
         * fractionWidth = 33% (of screen)
         */

        if (mouse.x >= 0.5) {
          data.vX = ((mouse.x - 0.5) / 0.33) * data.vXMax;
        } else {
          data.vX = (-(0.5 - mouse.x) / 0.33) * data.vXMax;
        }
      }

      // and limit
      // NOTE: big restraint on "real" vXMax, here.
      data.vX = Math.max(
        -data.vXMax * 0.6,
        Math.min(data.vXMax * 0.6, data.vX)
      );

      data.vY = (mouseY - data.y - data.halfHeight) * 0.05;

      // and limit
      data.vY = Math.max(-data.vYMax, Math.min(data.vYMax, data.vY));
    }
  }

  /**
   * Prevent X-axis motion if landed, including on landing pad.
   * Y-axis is motion still allowed, so chopper can move upward
   * and leave this state.
   */
  if (!data.dead && (data.landed || data.onLandingPad)) {
    data.vX = 0;
  }

  /**
   * Has the helicopter landed?
   * TODO: note and fix(?) slight offset, helicopter may fall short of
   * perfect alignment with bottom.
   *
   */
  yOffset = data.isCPU ? 0 : 3;

  maxY = worldHeight - data.height + yOffset;

  /**
   * Allow helicopter to land on the absolute bottom, IF it is not
   * on a landing pad (which sits a bit above.)
   */
  if (data.y >= maxY && data.vY > 0 && !data.landed) {
    // slightly annoying: allow one additional pixel when landing.
    data.y = maxY + 1;

    if (data.isLocal && !data.isCPU) {
      /**
       * TODO: notify of opponent crash when in network, etc.
       * "Safety" check: if moving too fast, this is a crash as per original.
       */
      if (!data.dead && Math.abs(data.vX) >= data.vXMax / 2 - 2) {
        game.objects.notifications.add(
          'You hit the ground going too fast. 🚁💥'
        );
        die(exports);
        return;
      }

      maybeRumbleOnLanding(exports);
    }

    moveTo(exports, data.x, data.y);

    data.landed = true;
  } else if (data.dead || (data.vY < 0 && (data.landed || data.onLandingPad))) {
    // once landed, only leave once we're moving upward.
    data.landed = false;
    onLandingPad(exports, false);
  } else if (data.onLandingPad) {
    // ensure the helicopter stays aligned with the landing pad.
    data.y = maxY - yOffset;
  }

  if (data.landed && !data.isCPU) {
    // don't throw bullets with vY, if landed
    data.vY = 0;
  }

  // no fuel?
  if (data.fuel <= 0 || !data.pilot) {
    // gravity until dead.
    if (data.vY < 0.5) {
      data.vY += 0.5 * GAME_SPEED_RATIOED;
    } else {
      data.vY *= 1 + 0.1 * GAME_SPEED_RATIOED;
    }

    if (data.landed) {
      die(exports);
    }
  }

  // safety valve: don't move if ignoreMouseEvents
  if (data.ignoreMouseEvents) {
    data.vX = 0;
    data.vY = 0;
  }

  /**
   * Take the difference between the game speed and real-time,
   * if less than real-time.
   */
  const RELATIVE_GAME_SPEED = GAME_SPEED_RATIOED; // (GAME_SPEED < 1 ? (1 - (GAME_SPEED / 2)) : GAME_SPEED);

  if (!data.dead) {
    moveTo(
      exports,
      data.x + data.vX * RELATIVE_GAME_SPEED,
      data.y + data.vY * RELATIVE_GAME_SPEED
    );

    collisionTest(collision, exports);

    // repairing?
    if (data.repairing) {
      repair(exports);
    }

    effects.smokeRelativeToDamage(exports);
  }

  // animate child objects, too
  // TODO: move out to game.objects

  for (i = objects.bombs.length - 1; i >= 0; i--) {
    if (objects.bombs[i].animate()) {
      // object is dead - take it out.
      spliceArgs[0] = i;
      Array.prototype.splice.apply(objects.bombs, spliceArgs);
    }
  }

  for (i = objects.smartMissiles.length - 1; i >= 0; i--) {
    if (objects.smartMissiles[i].animate()) {
      // object is dead - take it out.
      spliceArgs[0] = i;
      Array.prototype.splice.apply(objects.smartMissiles, spliceArgs);
    }
  }

  // should we be firing, also?

  if (!data.dead) {
    if (data.isLocal && game.objects.gameLoop.data.frameCount % 10 === 0) {
      scanRadar(exports);
    }

    fire(exports);
  }

  if (data.isLocal) {
    const vans = game.objects[TYPES.van];

    // any enemy vans that are jamming our radar?
    for (i = 0, j = vans.length; i < j; i++) {
      if (
        !vans[i].data.dead &&
        vans[i].data.isEnemy !== data.isEnemy &&
        vans[i].data.jamming
      ) {
        jamming++;
      }
    }

    if (jamming && !data.radarJamming) {
      data.radarJamming = jamming;
      game.objects.radar.startJamming();
    } else if (!jamming && data.radarJamming) {
      data.radarJamming = jamming;
      game.objects.radar.stopJamming();
    }
  }

  burnFuel(exports);

  if (data.isCPU && !data.isRemote) {
    if (!data.onLandingPad || !repairInProgress(exports)) {
      data.ai?.animate();
    }

    centerView(exports);

    if (game.objects.gameLoop.data.frameCount % data.targetingModulus === 0) {
      // determines smart missile counter-measures
      let defendB = (game.iQuickRandom() & 0xf) < levelConfig.clipSpeedI;

      /**
       * Determines whether "in combat" with nearby missile or chopper,
       * whether to go after / kill the helicopter, AND, some counter-measures
       * like dropping bombs and men.
       */
      let attackB = !!(game.iQuickRandom() & 0x7);

      // only related to capturing the end bunker / funds
      let stealB = !(game.getRandSeedUI() & 0x30);

      // TODO: implement shooting tanks with gunfire and dumb / aimed missiles.
      data.targeting.tanks = levelConfig.killTankB && levelConfig.scatterBombB;

      data.targeting.clouds = aiRNG(exports) > 0.65;
      data.targeting.bunkers = true;
      data.targeting.superBunkers = game.objects[TYPES.superBunker].length;
      data.targeting.endBunkers = stealB && levelConfig.killEndB;
      data.targeting.men = levelConfig.killMenB;
      data.targeting.vans = levelConfig.killVanB;
      data.targeting.turrets = true;

      // go after choppers if allowed by level config, OR, in tutorial mode.
      data.targeting.helicopters =
        (levelConfig.killCopterB && attackB) || tutorialMode;

      data.targeting.defendB = defendB;
      data.targeting.attackB = attackB;
      data.targeting.stealB = stealB;

      if (debug || debugCollision) {
        console.log(
          `AI tank targeting mode: ${data.targeting.tanks}, clouds: ${data.targeting.clouds}, bunkers: ${data.targeting.bunkers}, helicopters: ${data.targeting.helicopters}`
        );
      }
    }
  }

  updateCloakState(exports);

  // uncloak if not in a cloud?
  uncloak(exports);
}

function reactToDamage(exports, attacker) {
  let { data, timers } = exports;

  // hackish: data.exploding is true before dead = true, long story short here.
  if (gamePrefs.gamepad && gamepad.data.active) {
    if (data.dead || !data.energy || data.exploding) {
      // throttle
      if (!timers.rumbleTimer) {
        timers.rumbleTimer = common.setFrameTimeout(
          () => (data.rumbleTimer = null),
          1000
        );
        gamepad.rumble(
          0.65,
          200,
          'reactToDamage: dead || !energy || exploding'
        );
      }
    } else {
      gamepad.rumble(
        0.65,
        50,
        'reactToDamage: not dead, has energy, not exploding'
      );
    }
  }

  // extra special case: BnB + chopper being hit by shrapnel or enemy gunfire.
  if (!gamePrefs.bnb) return;

  // make a racket, depending
  if (!data.lastReactionSound) {
    data.lastReactionSound = true;

    playSound(
      sounds.bnb[
        game.data.isBeavis ? 'beavisScreamShort' : 'buttheadScreamShort'
      ],
      exports,
      {
        onfinish: (sound) => {
          data.lastReactionSound = null;
          /**
           * Call the "main" onfinish, which will hit onAASoundEnd() and
           * destroy things cleanly.
           *
           * Hackish: ensure that sound has not already been destroyed,
           * prevent infinite loop.
           *
           * NOTE: I dislike this pattern and wish to do away with it. ;)
           */
          if (!sound.disabled) {
            sound.options.onfinish(sound);
          }
        }
      }
    );
  }

  // next section: butthead only
  if (!game.data.isButthead) return;

  // just in case
  if (!attacker) return;

  // already queued?
  if (timers.commentaryTimer) return;

  timers.commentaryTimer = common.setFrameTimeout(
    () => {
      // don't run too often
      const now = Date.now();
      timers.commentaryTimer = null;
      if (now - data.commentaryLastExec < data.commentaryThrottle) return;

      // "still fighting"?
      if (!isAttackerValid(exports, attacker)) return;

      function onplay(sound) {
        // attacker may have died between queue and playback start
        if (!isAttackerValid(exports, attacker)) skipSound(sound);
      }

      // finally!
      playSound(sounds.bnb.beavisCmonButthead, null, {
        onplay,
        onfinish: function (sound) {
          if (sound.skipped || !isAttackerValid(exports, attacker)) return;
          // "you missed, butt-head."
          common.setFrameTimeout(
            () => {
              playSound(sounds.bnb.beavisYouMissed, null, {
                onplay,
                onfinish: (sound2) => {
                  if (sound2.skipped) return;
                  playSoundWithDelay(
                    sounds.bnb.beavisYouMissedResponse,
                    null,
                    { onplay },
                    1000
                  );
                }
              });
            },
            5000 + rndInt(2000)
          );
        }
      });

      data.commentaryLastExec = now;
    },
    2000 + rndInt(2000)
  );
}

function isAttackerValid(exports, attacker) {
  // "still fighting and in view"
  return !exports.data.dead && !attacker.data.dead && attacker.data.isOnScreen;
}

function onHit(exports, attacker) {
  let { data } = exports;

  // generic callback event: we've been hit by something.
  // for helicopters, only of interest for CPU AI.
  if (data.isCPU) {
    data.ai?.onHit(attacker);
  }
}

function onKill(exports, targetID) {
  let { data } = exports;

  let target = getObjectById(targetID);

  if (!data.isCPU) return;
  if (target?.data && target.data.type !== TYPES.helicopter) return;
  // CPU case: stop chasing helicopters, since we got one.
  if (gameType === 'tutorial' || gameType === 'easy') {
    data.targeting.helicopters = false;
  }
}

function callMethod(exports, method, params) {
  // no arguments.
  if (params === undefined) return exports[method]();

  // array? spread as arguments.
  if (params.length) return exports[method](...params);

  // single value.
  return exports[method](params);
}

const pendingActions = {};

function callAction(exports, method, value) {
  /**
   * Local keyboard input handler.
   * May act immediately, or send via network and delay somewhat.
   */
  let { data } = exports;

  if (!exports[method]) {
    console.warn('callAction: WTF no method by this name?', method, value);
    return;
  }

  /**
   * If not a network game, OR a remote object taking calls,
   * just do the thing right away.
   */
  if (!net.active || data.isRemote) return callMethod(exports, method, value);

  /**
   * Presently, `value` is only boolean.
   * If this changes, this will break and will need refactoring. :P
   * This throttles repeat calls with the same value, while the change
   * is pending e.g., setFiring(true);
   */
  const pendingId = `${method}_${value ? 'true' : 'false'}`;

  // we're already doing this.
  if (pendingActions[pendingId]) return;

  const params = [value];

  // special case: for smart missiles, also pass over the missile type -
  // e.g., `setMissileLaunching(true, 'rubber-chicken-mode')`
  // this ensures consistency on both sides.
  if (method === 'setMissileLaunching') {
    params.push(game.objects.view.data.missileMode);
  }

  // delay; send the thing, then do the thing.
  net.sendMessage({ type: 'GAME_EVENT', id: data.id, method, params });

  // set the timer, and clear when it fires.
  pendingActions[pendingId] = common.setFrameTimeout(() => {
    pendingActions[pendingId] = null;
    delete pendingActions[pendingId];
    callMethod(exports, method, value);
  }, net.halfTrip);
}

function getFiringRates() {
  return {
    // "modern" vs. classic firing intervals.
    // also, values that need scaling for 30 / 60 FPS.

    smartMissileRepairModulus: {
      default: 128
    },

    bombRepairModulus: {
      default: 10
    },

    ammoRepairModulus: {
      default: tutorialMode || levelFlags.bullets ? 2 : 10
    },

    energyRepairModulus: {
      default: 5
    },

    missileLaunchingModulus: {
      classic: 5,
      modern: 5
    },

    bombModulus: {
      classic: 6,
      modern: 4,
      cpu: {
        // special firing rates
        balloon: 90,
        helicopter:
          gameType === 'extreme' || gameType === 'armorgeddon'
            ? 12
            : gameType === 'hard'
              ? 24
              : 60,
        tank: 12
      }
    },

    fireModulus: {
      // NOTE: high value = effectively non-repeating.
      classic: levelFlags.bullets ? 3 : 999,
      modern: levelFlags.bullets ? 2 : 999,
      cpu: {
        // special firing rates - w/aimed missiles, faster with game difficulty
        helicopter: levelFlags.bullets
          ? gameType === 'extreme' || gameType === 'armorgeddon'
            ? 2
            : gameType === 'hard'
              ? 3
              : 5
          : FPS /
            (gameType === 'extreme' || gameType === 'armorgeddon'
              ? 6
              : gameType === 'hard'
                ? 3
                : 2),
        balloon: levelFlags.bullets ? 10 : FPS * 1.5
      }
    },

    parachuteModulus: {
      classic: 8,
      modern: 4
    },

    parachutingDelayFlying: {
      classic: 200,
      modern: 100
    },

    parachutingDelayLanded: {
      classic: 300,
      modern: 210
    }
  };
}

function adjustForGameSpeed(value) {
  return parseInt(value * (1 / GAME_SPEED_RATIOED), 10);
}

function setCPUBombingRate(exports, targetType) {
  let { data, firingRates } = exports;

  // special case: CPU bombing can vary depending on target.
  if (firingRates.bombModulus.cpu[targetType]) {
    data.bombModulus = firingRates.bombModulus.cpu[targetType];
    return;
  }

  // restore default, if not specified or no match.
  const rateType = 'bombModulus';
  data[rateType] = setFiringRate(exports, [rateType]);
}

function setCPUFiringRate(exports, targetType) {
  let { data, firingRates } = exports;

  // special case: CPU gunfire can vary depending on target.
  if (firingRates.fireModulus.cpu[targetType]) {
    data.fireModulus = adjustForGameSpeed(
      firingRates.fireModulus.cpu[targetType]
    );
    return;
  }

  // restore default, if not specified or no match.
  const rateType = 'fireModulus';
  data[rateType] = adjustForGameSpeed(setFiringRate(exports, [rateType]));
}

function setFiringRate(exports, type) {
  let { firingRates } = exports;

  // apply according to prefs.
  const pref = gamePrefs.weapons_interval_classic ? 'classic' : 'modern';

  return adjustForGameSpeed(
    firingRates[type].default || firingRates[type][pref]
  );
}

function updateFiringRates(exports) {
  let { data, firingRates } = exports;

  // get and assign each new value, e.g. data['fireModulus'] = ...
  Object.keys(firingRates).forEach((key) => {
    data[key] = setFiringRate(exports, key);
  });

  // hackish: also, some FPS numbers.
  data.blinkCounterHide = 8 * (FPS / 30);
  data.blinkCounterReset = 16 * (FPS / 30);
}

function setSpinner(exports, spinning) {
  let { css, dom, timers } = exports;

  if (spinning) {
    utils.css.add(dom.oSpinner, css.animating, css.active);
    timers.spinnerTimer?.reset();
    timers.spinnerTimer = null;
    return;
  }

  // remove
  utils.css.remove(dom.oSpinner, css.active);

  // once faded, drop animation.
  if (!timers.spinnerTimer) {
    timers.spinnerTimer = common.setFixedFrameTimeout(() => {
      utils.css.remove(dom.oSpinner, css.animating);
      timers.spinnerTimer = null;
    }, 600);
  }
}

export { Helicopter };
