import { game } from '../core/Game.js';
import { common } from '../core/common.js';
import {
  ENEMY_UNIT_COLOR,
  ENERGY_TIMER_DELAY,
  ENERGY_TIMER_FADE_RATIO,
  FPS,
  GAME_SPEED,
  TYPES,
  isSafari,
  noRadar,
  rng,
  searchParams
} from '../core/global.js';
import { utils } from '../core/utils.js';
import { levelFlags } from '../levels/default.js';
import { PREFS, gamePrefs } from './preferences.js';

const debugCanvas = searchParams.get('debugCanvas');

let canvasConfig = [];
let ctxOptionsById = {};

let battlefield = 'battlefield';
let radar = 'radar';

function refreshCanvasConfig() {
  canvasConfig = [
    // dom ID vs. object name / reference - e.g., `dom.o.battlefield` / `dom.ctx.battlefield`
    {
      id: `${radar}-canvas`,
      name: radar,
      ctxOptions: {
        alpha: false,
        imageSmoothingEnabled: true,
        useDevicePixelRatio: true
      }
    },
    {
      id: `${battlefield}-canvas`,
      name: battlefield,
      ctxOptions: {
        alpha: false,
        imageSmoothingEnabled: false,
        useDevicePixelRatio: !!gamePrefs.gfx_hi_dpi
      }
    }
  ];

  ctxOptionsById = {};
  canvasConfig.forEach((item) => (ctxOptionsById[item.id] = item.ctxOptions));
}

// certain objects render in certain places.
const ctxByType = {
  'default': battlefield,
  'radar-item': radar,
  // special generic case
  'on-radar': radar
};

const pos = {
  // positioning / coordinate helper methods
  // e.g., a bunker or tank on the radar
  left: (left) =>
    left * game.objects.radar.data.scale -
    game.objects.radar.data.radarScrollLeft,
  bottomAlign: (height, obj) =>
    32 * game.objects.view.data.screenScale -
    height *
      (obj?.data?.stepOffset !== undefined ? obj?.data?.stepOffset : 1) *
      game.objects.radar.data.itemScale,
  top: (top) => top * game.objects.view.data.screenScale,
  width: (width) => width * game.objects.radar.data.itemScale,
  // offset for outline / stroke
  height: (height) => (height + 0.5) * game.objects.radar.data.itemScale,
  heightNoStroke: (height) => height * game.objects.radar.data.itemScale
};

const DomCanvas = () => {
  // given a DOM/CSS-like data structure, draw it on canvas.
  let data, dom, exports;

  data = {
    // width + height cached by name
    ctxLayout: {},
    canvasLayout: {}
  };

  dom = {
    // see canvasConfig
    o: {
      battlefield: null,
      radar: null
    },
    ctx: {
      battlefield: null,
      radar: null
    }
  };

  function applyCtxOptions() {
    canvasConfig.forEach((config) => {
      if (config.ctxOptions) {
        Object.keys(config.ctxOptions).forEach((key) => {
          dom.ctx[config.name][key] = config.ctxOptions[key];
        });
      }
    });
  }

  function initCanvas() {
    canvasConfig.forEach((config) => {
      // DOM node by id
      dom.o[config.name] = document.getElementById(config.id);

      // context by name
      dom.ctx[config.name] = dom.o[config.name].getContext(
        '2d',
        config.ctxArgs || {}
      );
    });
    applyCtxOptions();
  }

  function clear() {
    for (const name in dom.ctx) {
      // may not have layout yet...
      if (!data.ctxLayout[name]) continue;
      dom.ctx[name].clearRect(
        0,
        0,
        data.ctxLayout[name].width,
        data.ctxLayout[name].height
      );
    }
  }

  function canvasAnimation(exports, options = {}) {
    if (!exports?.data) return;

    if (!options?.sprite) {
      console.warn('canvasAnimation: no options.sprite?', exports, options);
      return;
    }

    const { sprite } = options;

    let { skipFrame } = options;

    // HACK: replace e.g., 'tank_#' with 'tank_0' for initial render.
    let img = utils.image.getImageObject(sprite.url.replace('#', 0));

    const {
      width,
      height,
      frameWidth,
      frameHeight,
      horizontal,
      loop,
      alternate,
      hideAtEnd
    } = sprite;

    let { reverseDirection } = sprite;

    const animationDuration = options.sprite.animationDuration || 1;

    // mutate the provided object
    const { data } = exports;

    let frameCount = 0;

    let animationFrame = 0;

    let spriteOffset = 0;

    // take direct count, OR assume vertical sprite, unless specified otherwise.
    // TODO: normalize where this property lives
    let animationFrameCount =
      options.sprite.animationFrameCount ||
      options?.animationFrameCount ||
      (horizontal ? width / frameWidth : height / frameHeight);

    // sneaky: if "hide at end", add one extra (empty) frame.
    if (hideAtEnd) animationFrameCount++;

    let stopped;
    let onEndFired;

    const newImg = {
      src: img,
      source: {
        x: 0,
        y: 0,
        is2X: true,
        // full sprite dimensions
        width,
        height,
        // per-frame dimensions
        frameWidth,
        frameHeight,
        // sprite offset indices
        frameX: 0,
        frameY: 0
      },
      target: {
        width: width / 2,
        height: frameHeight / 2,
        // scale up to match size of the thing blowing up, as applicable.
        scale: options.scale || 1,
        // approximate centering of explosion sprite vs. original
        xOffset: options.xOffset || 0,
        yOffset: options.yOffset || 0,
        useDataAngle: !!options.useDataAngle,
        opacity: exports.data.opacity
      }
    };

    // adding to existing sprite(s) as an array, e.g., an explosion on top of a turret before it dies

    let { domCanvas } = exports;

    if (options.overlay && domCanvas.img) {
      if (Array.isArray(domCanvas.img)) {
        domCanvas.img.push(newImg);
      } else {
        domCanvas.img = [domCanvas.img, newImg];
      }
    } else {
      domCanvas.img = newImg;
    }

    // assign a reference to the new source (e.g., on a turret), whether replaced or added.
    let thisImg = newImg;

    function applyOffset() {
      // imageSequence case - e.g., tank_# -> tank_0.png and so forth
      if (sprite.url.indexOf('#') !== -1) {
        // e.g., tank_0.png -> tank_2.png
        const offset = reverseDirection
          ? animationFrameCount - 1 - spriteOffset
          : spriteOffset;

        // hackish: if hideAtEnd, take empty frame into account.
        // otherwise, things go sideways.
        if (hideAtEnd && offset >= animationFrameCount - 1) {
          thisImg.src = utils.image.getImageObject();
        } else {
          thisImg.src = utils.image.getImageObject(
            sprite.url.replace('#', offset || 0)
          );
        }
      } else if (horizontal) {
        thisImg.source.frameX = reverseDirection
          ? animationFrameCount - 1 - spriteOffset
          : spriteOffset;
      } else {
        thisImg.source.frameY = reverseDirection
          ? animationFrameCount - 1 - spriteOffset
          : spriteOffset;
      }
    }

    function animate() {
      // FPS + game speed -> animation speed ratio.
      // TODO: reduce object churn - update only when FPS and/or game speed change.
      const animationModulus = Math.floor(
        FPS * (1 / GAME_SPEED) * (1 / 10) * animationDuration
      );

      if (skipFrame) {
        /**
         * HACK: this is for the case when the helicopter is changing directions,
         * and the first frame is shown for two frames' time. This hacks around it.
         * TODO: figure out why this happens and fix it.
         */
        frameCount = animationModulus;
        skipFrame = false;
      }

      // all frames have run...
      if (stopped) {
        // don't persist last frame
        if (hideAtEnd) return;

        // delay one more animation frame before reset, so last doesn't disappear immediately.
        if (options.onEnd && !onEndFired) {
          if (frameCount > 0 && frameCount % animationModulus === 0) {
            onEndFired = true;
            options.onEnd();
          } else {
            // waiting to end...
            frameCount++;
          }
        }

        // draw last frame until instructed otherwise.
        return draw(exports);
      }

      if (frameCount > 0 && frameCount % animationModulus === 0) {
        // hackish note: apply offset before increment.
        applyOffset();

        // next frame: default spritesheet shenanigans.
        spriteOffset++;
        animationFrame++;

        if (animationFrame >= animationFrameCount) {
          // done!
          animationFrame = 0;
          frameCount = 0;
          spriteOffset = 0;
          if (!loop) {
            stopped = true;
          } else {
            // alternate direction on loop?
            if (alternate) reverseDirection = !reverseDirection;
          }
        } else {
          frameCount++;
        }
      } else {
        // HACK: ensure the first frame is set right away.
        if (!frameCount && !loop) {
          // prevent a potential flash of the "un-reversed" sprite...
          applyOffset();
          // HACK: avoid showing the first frame for twice the duration.
          frameCount = animationModulus;
        } else {
          frameCount++;
        }
      }

      draw(exports);
    }

    return {
      animate,
      sprite,
      img: newImg,
      stop: () => (stopped = true),
      resume: () => (stopped = false),
      restart: () => {
        frameCount = 0;
        stopped = false;
      },
      // NB: updating both img references.
      updateSprite: (newURL) =>
        (thisImg.src = img = utils.image.getImageObject(newURL))
    };
  }

  // center, scale, and rotate.
  // https://stackoverflow.com/a/43155027
  function drawImageCenter(
    ctx,
    image,
    x,
    y,
    cx,
    cy,
    width,
    height,
    scale,
    rotation,
    destX,
    destY
  ) {
    // scale, and origin (offset) for rotation
    ctx.setTransform(scale, 0, 0, scale, destX + width / 2, destY + width / 2);

    // deg2rad
    ctx.rotate((rotation || 0) * 0.0175);

    // copy one frame from the sprite
    ctx.drawImage(
      image,
      x - cx,
      y - cy,
      width,
      height,
      -width / 2,
      -height / 2,
      width,
      height
    );

    // reset the origin transform
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    // restore scale, too.
    ctx.scale(ctx.ctxScale || 1, ctx.ctxScale || 1);
  }

  function rotate(
    ctx,
    angle,
    x,
    y,
    w,
    h,
    rotateXOffset = 0.5,
    rotateYOffset = 0.5
  ) {
    // rotate from center of object
    const centerX = x + w * rotateXOffset;
    const centerY = y + h * rotateYOffset;

    // move to the center
    ctx.translate(centerX, centerY);

    ctx.rotate((angle * Math.PI) / 180);

    // back to "relative" origin
    ctx.translate(-centerX, -centerY);
  }

  function unrotate(ctx) {
    // reset the origin transform
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // and restore scale, too.
    if (ctx.ctxScale) {
      ctx.scale(ctx.ctxScale, ctx.ctxScale);
    }
  }

  function startShadowBlur(ctx, exports) {
    const { data } = exports;
    const ss = game.objects.view.data.screenScale * (gamePrefs.gfx_hi_dpi ? 2 : 1);

    const tracking =
      !data.dead && (data.smartMissileTracking || data.isNextMissileTarget);

    // smart missile: next, or current target?
    if (tracking) {
      // radius approximately matching CSS glow.
      ctx.shadowBlur = 8 * ss;
      // current (active) vs. next detected target
      ctx.shadowColor = data.smartMissileTracking ? '#ff3333' : '#999';
    } else if (data.shadowBlur) {
      // TODO: cache.
      ctx.shadowBlur = data.shadowBlur * ss;
      ctx.shadowColor = data.shadowColor || '#fff';
    }

    /**
     * 02/2024: Safari screws up `shadowBlur` rendering on "pixelated" contexts.
     * Work around this by enabling image smoothing while `shadowBlur` is present.
     * These effects should be somewhat ephemeral, on missile targets and explosions.
     */
    let shadowSmoothingHack =
      isSafari && (tracking || data.shadowBlur) && !ctx.imageSmoothingEnabled;

    if (shadowSmoothingHack) {
      ctx.imageSmoothingEnabled = true;
    }
  }

  function endShadowBlur(ctx, exports) {
    const { data } = exports;

    const tracking =
      !data.dead && (data.smartMissileTracking || data.isNextMissileTarget);

    // reset blur
    if (tracking || data.shadowBlur) {
      ctx.shadowBlur = 0;
      let shadowSmoothingHack =
        isSafari && (tracking || data.shadowBlur) && ctx.imageSmoothingEnabled;

      if (shadowSmoothingHack) {
        ctx.imageSmoothingEnabled = false;
      }
    }
  }

  function drawImage(ctx, exports, imgObject, drawOpacity = 1) {
    const { data } = exports;
    const { domCanvas } = exports;
    const ss = game.objects.view.data.screenScale;

    const img = imgObject || domCanvas.img;

    // only display if loaded
    if (img && !img.src) {
      if (!game.objects.editor) {
        console.warn(
          'domCanvas: img.src not yet assigned?',
          img,
          data.type,
          data.id
        );
      }
      return;
    }

    if (img && !img.src.complete) {
      /**
       * Note incomplete images, not necessarily "broken."
       * This can occur when a sprite is first loaded,
       * without having been prefetched.
       */
      console.info('Image has not completed', data.type, data.id);
      return;
    }

    let { source, target } = img;

    if (!target) target = {};

    // opacity on object, and/or "draw" opacity
    if (target.opacity >= 0 || drawOpacity !== 1) {
      ctx.globalAlpha = (target.opacity || 1) * drawOpacity;
    }

    // single image, vs. sprite?
    if (
      !target.rotation &&
      source.frameX === undefined &&
      source.frameY === undefined
    ) {
      // screwy scaling here, but 2x source -> target @ 50% (if unspecified), plus screen scaling
      const renderedWidth = (target.width || source.width / 2) * ss;
      const renderedHeight = (target.height || source.height / 2) * ss;

      const targetX =
        ((target.x || 0) -
          game.objects.view.data.battleField.scrollLeft +
          (target.xOffset || 0)) *
        ss;

      // radar and other offsets, plus 4-pixel shift, AND "step" offset (summon / dismiss transition, if active.)
      let targetY;

      if (data.isTerrainItem) {
        targetY =
          ((target.y || 0) - 32) * ss +
          (target.yOffset || 0) * ss +
          ss * 4 -
          renderedHeight *
            (data.stepOffset !== undefined ? data.stepOffset : 1);
      } else if (data.bottomAligned && !data.isTerrainItem) {
        // TODO: figure out why terrain items are mis-aligned if treated as bottom-aligned.
        // MTVIE?
        // worldHeight is 380, but bottom of battlefield is 368.
        targetY =
          ((data.type === TYPES.superBunker ||
          (data.type === TYPES.bunker && !data.dead)
            ? 380
            : 368) +
            (target.yOffset || 0)) *
            ss -
          renderedHeight *
            2 *
            (data.stepOffset !== undefined ? data.stepOffset : 1);
      } else {
        // regular airborne items like clouds, etc.
        targetY = ((target.y || 0) - 32) * ss + (target.yOffset || 0);
      }

      // debugging: static images
      if (debugCanvas) {
        ctx.beginPath();
        ctx.rect(targetX, targetY, renderedWidth, renderedHeight);
        ctx.strokeStyle = '#fff';
        ctx.stroke();
      }

      startShadowBlur(ctx, exports);

      // single image
      ctx.drawImage(
        img.src,
        source.x,
        source.y,
        source.width,
        source.height,
        targetX,
        targetY,
        renderedWidth,
        renderedHeight
      );

      endShadowBlur(ctx, exports);

      // TODO: only draw this during energy updates / when applicable per prefs.
      if (
        !img.excludeEnergy &&
        (gamePrefs.show_health_status === PREFS.SHOW_HEALTH_ALWAYS ||
          exports.data.energyCanvasTimer)
      ) {
        drawEnergy(exports, ctx);
      }
      // single image, rotated?
    } else if (
      target.rotation &&
      source.frameX === undefined &&
      source.frameY === undefined
    ) {
      // (image, x, y, cx, cy, width, height, scale, rotation, destX, destY)
      drawImageCenter(
        ctx,
        img.src,
        source.frameWidth * (source.frameX || 0),
        source.frameHeight * (source.frameY || 0),
        0,
        0,
        source.frameWidth,
        source.frameHeight,
        (target.scale || 1) * (ss * 0.5),
        target.rotation || 0,
        (data.x -
          game.objects.view.data.battleField.scrollLeft +
          (target.xOffset || 0)) *
          ss,
        (data.y - 32) * ss + (target.yOffset || 0)
      );
    } else {
      // sprite case; note 32 offset for radar before scaling
      // TODO: scaling and centering of rendered cropped sprite, e.g., smoke object with data.scale = 1.5 etc.
      const dWidth =
        source.frameWidth * ss * (source.is2X ? 0.5 : 1) * (target.scale || 1);

      const dHeight =
        source.frameHeight * ss * (source.is2X ? 0.5 : 1) * (target.scale || 1);

      const dx =
        (data.x -
          game.objects.view.data.battleField.scrollLeft +
          (target.xOffset || 0)) *
        ss;

      // this should be wrong, but works for airborne sprites - TODO: debug / fix as needed.
      let dy = (data.y - 32) * ss + (target.yOffset || 0) * ss;

      if (data.bottomAligned) {
        // TODO: WTF
        dy = 351 * ss - dHeight + (target.yOffset || 0) * ss;
      }

      // for bottom-aligned / terrain items that use sprites - offset vertical based on "step."
      if (data.stepOffset !== undefined) {
        dy += dHeight * (1 - data.stepOffset);
      }

      const angle =
        target.angle || (target.useDataAngle && (data.rotation || data.angle));

      if (angle) {
        rotate(
          ctx,
          angle,
          dx,
          dy,
          dWidth,
          dHeight,
          target.rotateXOffset,
          target.rotateYOffset
        );
      }

      // debugging sprite canvas drawing...
      if (debugCanvas) {
        ctx.beginPath();
        ctx.rect(dx, dy, dWidth, dHeight);
        ctx.strokeStyle = '#33cc33';
        ctx.stroke();
      }

      startShadowBlur(ctx, exports);

      // drawImage(image, sx, sy, sWidth, sHeight, dx, dy, dWidth, dHeight)
      ctx.drawImage(
        img.src,
        source.frameWidth * (source.frameX || 0),
        source.frameHeight * (source.frameY || 0),
        source.frameWidth,
        source.frameHeight,
        dx,
        dy,
        dWidth,
        dHeight
      );

      if (angle) {
        unrotate(ctx);
      }

      endShadowBlur(ctx, exports);

      // TODO: only draw this during energy updates / when applicable per prefs.
      if (
        !img.excludeEnergy &&
        (gamePrefs.show_health_status === PREFS.SHOW_HEALTH_ALWAYS ||
          exports.data.energyCanvasTimer)
      ) {
        drawEnergy(exports, ctx);
      }
    }

    if (target.opacity >= 0 || drawOpacity !== 1) {
      ctx.globalAlpha = 1;
    }
  }

  function draw(exports) {
    // original object data
    const { data } = exports;

    const oData = exports.domCanvas;

    if (!oData) {
      console.warn('DomCanvas: no data?', oData);
      return;
    }

    /**
     * Prevent redundant / excessive canvas drawing calls, one per frame.
     * NOTE: Radar needs to "redraw" on frame 0, before game start.
     * TODO: reduce the need for this sanity check.
     */
    if (
      exports.data._drawFrame === game.objects.gameLoop.data.frameCount &&
      game.data.started
    )
      return;

    // update
    exports.data._drawFrame = game.objects.gameLoop.data.frameCount;

    // determine target canvas by type - specified by object, type, or default.
    const ctx =
      dom.ctx[oData.ctxName] ||
      dom.ctx[ctxByType[data.type] || ctxByType.default];

    // shared logic for <canvas> elements
    // does not apply to bottom-aligned units, i.e., MTVIE, or balloons.
    if (
      (data.dead || data.blink) &&
      !data.excludeBlink &&
      !data.bottomAligned &&
      !data.alwaysDraw &&
      data.type !== TYPES.balloon
    ) {
      // special case for helicopters: only blink radar item while initially exploding, not reset or respawning.
      if (
        data.type === 'radar-item' &&
        data.parentType === TYPES.helicopter &&
        !game.objectsById[data.oParent]?.data?.exploding
      ) {
        return;
      }

      // only draw every X
      data.blinkCounter = data.blinkCounter || 0;
      data.blinkCounter++;

      // TODO: DRY / move to static value
      if (data.blinkCounter % (FPS === 60 ? 6 : 3) === 0) {
        data.visible = !data.visible;
      }
    }

    // don't draw if explictly not visible (not undefined / false-y)
    // HACK: ignore helicopters, otherwise the player's radar item disappears after dying. TODO: debug and fix.
    if (
      game.objectsById[data.oParent]?.data?.type !== TYPES.helicopter &&
      data.visible === false
    )
      return;

    // run logic, but don't actually draw if not on-screen.
    if (!exports.data.isOnScreen) return;

    // special radar no-draw cases
    if (data.type === 'radar-item' || oData.ctxName === 'radar') {
      // jammed
      if (game.objects.radar.data.isJammed) return;

      // screencast mode
      if (noRadar) return;
    }

    /**
     * Hackish: assign random opacity if a radar item, and radar has interference per flags.
     * Don't draw opacity during level previews - only when game started.
     */
    if (
      levelFlags.jamming &&
      !gamePrefs.radar_interference_blank &&
      game.data.started &&
      (data.type === 'radar-item' || oData.ctxName === 'radar') &&
      oData.jammingOpacity === undefined
    ) {
      oData.jammingOpacity = 0.125 + rng(0.75, 'radar');
    }

    // does the object know how to draw itself?
    if (oData.draw) {
      // "standard style"
      if (
        !gamePrefs.radar_interference_blank &&
        oData.jammingOpacity &&
        oData.jammingOpacity !== 1
      ) {
        ctx.globalAlpha = oData.jammingOpacity;
      }
      ctx.beginPath();
      ctx.strokeStyle = '#000';
      // handle battlefield items, and radar items which link back to their parent.
      ctx.fillStyle =
        data.isEnemy || game.objectsById[data.oParent]?.data?.isEnemy
          ? ENEMY_UNIT_COLOR
          : '#17a007';
      // TODO: review oData vs. data, radar item vs. battlefield (e.g., chain object) logic.
      oData.draw(
        ctx,
        exports,
        pos,
        oData.width || data.width,
        oData.height || data.height
      );
      if (!oData.excludeFillStroke) {
        ctx.fill();
        if (!oData.excludeStroke) {
          ctx.stroke();
        }
      }
      if (
        gamePrefs.radar_interference_blank &&
        oData.jammingOpacity &&
        oData.jammingOpacity !== 1
      ) {
        ctx.globalAlpha = 1;
      }
      return;
    }

    let fillStyle;

    if (oData.img) {
      if (oData.img.forEach) {
        oData.img.forEach((imgObject) =>
          drawImage(ctx, exports, imgObject, oData.jammingOpacity)
        );
      } else {
        drawImage(ctx, exports, null, oData.jammingOpacity);
      }
    }

    // opacity?
    if (oData.opacity && oData.opacity !== 1 && oData.backgroundColor) {
      const rgb = oData.backgroundColor.match(/rgba/i)
        ? common.hexToRgb(oData.backgroundColor)
        : oData.backgroundColor;
      if (!rgb?.length) {
        console.warn(
          'DomCanvas.draw(): bad opacity / backgroundColor mix?',
          oData
        );
        return;
      }
      // rgba()
      fillStyle = `rgba(${rgb.join(',')},${oData.opacity})`;
    } else {
      fillStyle = oData.backgroundColor;
    }

    if (oData.borderRadius) {
      // roundRect time.
      ctx.fillStyle = fillStyle;
      ctx.beginPath();
      ctx.roundRect(
        cx(data.x),
        cy(data.y),
        cw(data.width),
        ch(data.height),
        oData.borderRadius
      );
      ctx.fill();
    }
  }

  function drawEnergy(exports, ctx) {
    let { data } = exports;

    if (data.energy === undefined) return;

    // special case: turrets can be dead and being repaired, non-zero energy until "restored"
    if (data.dead && data.energy === 0) return;

    if (gamePrefs.show_health_status === PREFS.SHOW_HEALTH_NEVER) return;

    // only draw if on-screen
    if (!data.isOnScreen) return;

    // don't show UI on enemy choppers while cloaked (in a cloud)
    if (data.cloaked && data.isEnemy !== game.players.local.data.isEnemy)
      return;

    // allow turrets being "restored" by engineers (dead, but not yet revived) to show energy.
    if ((data.energy <= 0 || data.dead) && !data.engineerInteracting) return;

    // fade out as timer counts down, fading within last fraction of a second
    let fpsOffset = FPS * ENERGY_TIMER_FADE_RATIO;

    let opacity;

    // account for custom timings, e.g., on turrets.
    let defaultTimer = FPS * ENERGY_TIMER_DELAY * (data.energyTimerScale || 1);

    let timerDelta = defaultTimer - data.energyCanvasTimer;

    // fade in, first.
    if (timerDelta < fpsOffset) {
      opacity = Math.min(1, Math.max(0, timerDelta / fpsOffset));
    } else {
      data.energyCanvasTimerFadeInComplete = true;
      // eventually, fade out
      opacity = Math.min(
        1,
        Math.max(0, Math.max(0, data.energyCanvasTimer - fpsOffset) / fpsOffset)
      );
    }

    if (data.energyCanvasTimer > 0) {
      data.energyCanvasTimer--;
    }

    if (data.energyCanvasTimer <= 0) {
      // reset the "fade-in" state.
      data.energyCanvasTimerFadeInComplete = false;
    }

    // timer up, OR don't "always" show
    if (
      data.energyCanvasTimer <= 0 &&
      gamePrefs.show_health_status !== PREFS.SHOW_HEALTH_ALWAYS
    )
      return;

    let energy = data.energy / data.energyMax;

    if (data.lastDrawnEnergy === undefined) {
      data.lastDrawnEnergy =
        data.lastEnergy !== undefined ? data.lastEnergy : 1;
    }

    // animate toward target energy
    let diff = energy - data.lastDrawnEnergy;

    // nothing to do?
    if (!diff) return;

    // "animate" the energy bar value change
    data.lastDrawnEnergy += diff * (1 / (FPS / 16));

    // hackish: re-assign "energy" as the value to draw.
    energy = data.lastDrawnEnergy;

    // don't draw at 100%.
    if (energy === 1) return;

    let outerRadius = 4.25;
    let innerRadius = 3.125;

    // TODO: DRY.
    let left = data.x;
    let top = data.y;

    if (data.type === TYPES.balloon) {
      left += data.halfWidth + 0.5;
      top += data.halfHeight - 0.5;
    } else if (data.type === TYPES.bunker) {
      left += data.halfWidth + 0.5 * game.objects.view.data.screenScale;
      top += data.height * 0.425;
    } else if (data.type === TYPES.helicopter) {
      if (data.isEnemy) {
        left += data.halfWidth + (data.flipped ? 8 : -3);
        top += data.halfHeight + 4;
      } else {
        left += data.halfWidth + (data.flipped ? -3 : 7);
        top += data.halfHeight + 2.5;
      }
      // wild hack: reference radar item while summoning (rising) from landing pad, as the offset lives there.
      if (exports.radarItem) {
        top +=
          exports.radarItem.data.stepOffset !== undefined
            ? data.height * (1 - exports.radarItem.data.stepOffset || 0)
            : 0;
      }
    } else if (
      data.type === TYPES.infantry ||
      data.type === TYPES.parachuteInfantry
    ) {
      left += data.halfWidth + (data.isEnemy ? 0 : 3);
      top -= outerRadius + 5;
      // special infantry offset case, accounting for moving back and forth while firing; also, yuck.
      left += exports.domCanvas?.animation?.img?.target?.xOffset || 0;
    } else if (data.type === TYPES.turret) {
      left += data.width - 1;
      top -= outerRadius + 4;
    } else if (data.type === TYPES.missileLauncher) {
      left += data.halfWidth;
      top += data.halfHeight;
    } else if (data.type === TYPES.van) {
      left += data.halfWidth;
      top += data.halfHeight - 2.5;
    } else if (data.type === TYPES.tank) {
      left += data.halfWidth + 1;
      top += data.halfHeight - 1.5;
    } else if (data.type === TYPES.superBunker) {
      left += data.halfWidth;
      top += 5.5;
    } else if (data.bottomAligned) {
      left += data.halfWidth + 0.5;
      top -= outerRadius + 2;
    }

    ctx.globalAlpha = opacity;

    // background / overlay
    ctx.beginPath();

    // "inner" dark border
    ctx.arc(
      cx(left),
      cy(top),
      outerRadius * game.objects.view.data.screenScale + 2,
      0,
      2 * Math.PI,
      false
    );
    ctx.fillStyle = 'rgba(32, 32, 32, 0.75)';
    ctx.fill();

    // "outer" light border
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.stroke();

    // inner circle
    ctx.beginPath();

    // "inner track" - which is always empty.
    ctx.arc(
      cx(left),
      cy(top),
      innerRadius * game.objects.view.data.screenScale,
      0,
      Math.PI * 2,
      false
    );
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(16, 16, 16, 1)';
    ctx.stroke();

    if (energy > 0.66) {
      ctx.strokeStyle = '#33cc33';
    } else if (energy > 0.33) {
      ctx.strokeStyle = '#cccc33';
    } else {
      ctx.strokeStyle = '#cc3333';
    }

    ctx.lineWidth = 3;

    ctx.beginPath();
    // start from 12 o'clock, then go counter-clockwise as energy decreases.
    ctx.arc(
      cx(left),
      cy(top),
      innerRadius * game.objects.view.data.screenScale,
      -Math.PI / 2,
      -Math.PI / 2 + Math.PI * 2 * energy,
      false
    );
    ctx.stroke();

    // animation when repairing (helicopters) / energy is going up (turret + tank self-repair.)
    if (data.repairing || data.energy > data.lastEnergy) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)';

      let progress = common.easing.cubic(
        (game.objects.gameLoop.data.frameCount % FPS) / FPS
      );

      // start moving circle start point forward, and shrinking ring size toward end.
      let offset = progress > 0.5 ? progress - 0.5 : 0;

      // inner animated ring
      ctx.beginPath();
      ctx.arc(
        cx(left),
        cy(top),
        innerRadius * game.objects.view.data.screenScale,
        // start
        -Math.PI / 2 + Math.PI * 2 * offset * 2,
        // end
        -Math.PI / 2 + Math.PI * 2 * progress,
        false
      );
      ctx.stroke();
    }

    ctx.globalAlpha = 1;
    ctx.lineWidth = 1;
  }

  function drawDebugRect(
    x,
    y,
    w,
    h,
    color = '#999',
    fillStyle = false,
    text = ''
  ) {
    const ctx = dom.ctx[battlefield];
    ctx.beginPath();
    ctx.rect(cx(x), cy(y), cw(w), ch(h));
    ctx.strokeStyle = color;
    ctx.setLineDash([3, 3]);
    if (fillStyle) {
      ctx.fillStyle = fillStyle;
      ctx.fill();
      ctx.fillStyle = '';
    }
    ctx.stroke();
    ctx.setLineDash([]);
    if (text) {
      ctx.font = '10px sans-serif';
      ctx.fillText(text, 10, 50);
    }
  }

  function drawPoint(vector, color, fill = false, ctx = dom.ctx.battlefield) {
    const radius = 3;
    if (!ctx) return;
    ctx.beginPath();
    ctx.arc(
      cx(vector.x),
      cy(vector.y),
      radius * game.objects.view.data.screenScale,
      0,
      2 * Math.PI,
      false
    );
    ctx.strokeStyle = color;
    ctx.stroke();
    if (fill) {
      ctx.fillStyle = color;
      ctx.fill();
    }
    ctx.closePath();
  }

  function cw(n) {
    return n * game.objects.view.data.screenScale;
  }

  function ch(n) {
    return n * game.objects.view.data.screenScale;
  }

  function cx(n) {
    // logical to display values
    return (
      (n - game.objects.view.data.battleField.scrollLeft) *
      game.objects.view.data.screenScale
    );
  }

  function cy(n) {
    // logical to display values
    return (n - 32) * game.objects.view.data.screenScale;
  }

  function drawForceVector(position, force, color, scale = MAX_AVOID_AHEAD) {
    let ctx = dom.ctx.battlefield;
    if (!ctx) return;
    ctx.beginPath();
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    ctx.moveTo(cx(position.x), cy(position.y));
    ctx.setLineDash([1, 1]);
    ctx.lineTo(
      cx(position.x + force.x * scale),
      cy(position.y + force.y * scale)
    );
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.closePath();
  }

  function drawTrailers(
    exports,
    xHistory = [],
    yHistory = [],
    xOffset = 0,
    yOffset = 0
  ) {
    const ctx = dom.ctx.battlefield;
    const ss = game.objects.view.data.screenScale;

    for (let i = 0, j = xHistory.length; i < j; i++) {
      ctx.beginPath();
      ctx.roundRect(
        (xHistory[i] +
          xOffset -
          game.objects.view.data.battleField.scrollLeft) *
          ss,
        (yHistory[i] - 32 + yOffset) * ss,
        1.25 * ss,
        1.25 * ss,
        2 * ss
      );
      // #666 -> 102, 102, 102
      ctx.fillStyle = `rgba(102, 102, 102, ${(i + 1) / j})`;
      ctx.fill();
    }
  }

  function resize() {
    if (!dom.o) return;

    // $$$
    for (const name in dom.o) {
      // may not have been initialized yet
      if (!dom.o[name]) continue;

      const canvasID = dom.o[name].id;

      // hi-DPI / retina option
      const ctxScale = ctxOptionsById[canvasID].useDevicePixelRatio
        ? window.devicePixelRatio || 1
        : 1;

      // reset to natural width, for measurement and scaling
      dom.o[name].style.width = '';
      dom.o[name].style.height = '';

      // measure the "natural" width
      const width = dom.o[name].offsetWidth;
      const height = dom.o[name].offsetHeight;

      data.canvasLayout[name] = {
        width,
        height
      };

      data.ctxLayout[name] = {
        width: width * ctxScale,
        height: height * ctxScale
      };

      // assign the scaled width
      dom.o[name].width = data.ctxLayout[name].width;
      dom.o[name].height = data.ctxLayout[name].height;

      // resize the canvas to 1x size, but render at (e.g.,) 2x pixel density if scale applies.
      dom.o[name].style.width = `${data.canvasLayout[name].width}px`;
      dom.o[name].style.height = `${data.canvasLayout[name].height}px`;

      // reset and restore transform origin + scale.
      dom.ctx[name].setTransform(1, 0, 0, 1, 0, 0);

      // hackish: tack on a reference
      dom.ctx[name].ctxScale = ctxScale;

      dom.ctx[name].scale(ctxScale, ctxScale);

      applyCtxOptions();
    }
  }

  function init() {
    // initial values - may change once preferences are read and/or updated.
    refreshCanvasConfig();
    initCanvas();
    resize();
  }

  exports = {
    canvasAnimation,
    clear,
    // TODO: don't expose data + DOM. :X
    data,
    dom,
    draw,
    drawForceVector,
    drawPoint,
    drawDebugRect,
    drawTrailers,
    init,
    onGFXHiDPIChange: () => {
      // gfx_hi_dpi preference update
      refreshCanvasConfig();
      init();
    },
    resize,
    rotate,
    unrotate
  };

  return exports;
};

export { ctxOptionsById, pos, DomCanvas };
