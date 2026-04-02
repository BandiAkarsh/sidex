/*---------------------------------------------------------------------------------------------
 *  SideX WASM Scroll Physics Bridge
 *  Loads the WASM scroll module and provides typed wrappers for the scroll engine.
 *--------------------------------------------------------------------------------------------*/

let wasmModule: any = null;
let initPromise: Promise<void> | null = null;
let initFailed = false;

async function ensureWasm(): Promise<any> {
	if (wasmModule) {
		return wasmModule;
	}
	if (initFailed) {
		return null;
	}
	if (!initPromise) {
		initPromise = (async () => {
			try {
				const mod = await import('/wasm/scroll/sidex_scroll_wasm.js');
				await mod.default();
				wasmModule = mod;
			} catch (e) {
				console.warn('[SideX] WASM scroll module not available, using JS fallback', e);
				initFailed = true;
			}
		})();
	}
	await initPromise;
	return wasmModule;
}

// Pre-load WASM eagerly
ensureWasm();

export interface IWasmScrollState {
	width: number;
	scrollWidth: number;
	scrollLeft: number;
	height: number;
	scrollHeight: number;
	scrollTop: number;
}

export interface IWasmSmoothScrollResult {
	scrollLeft: number;
	scrollTop: number;
	isDone: boolean;
}

export interface IWasmInertialState {
	speedX: number;
	speedY: number;
	active: boolean;
}

export interface IWasmScrollbarValues {
	sliderSize: number;
	sliderPosition: number;
	sliderRatio: number;
}

export interface IWasmWheelDelta {
	deltaX: number;
	deltaY: number;
}

export function wasmEaseOutCubic(t: number): number {
	if (!wasmModule) {
		const inv = 1 - t;
		return 1 - inv * inv * inv;
	}
	return wasmModule.ease_out_cubic(t);
}

export function wasmEaseInCubic(t: number): number {
	if (!wasmModule) {
		return Math.pow(t, 3);
	}
	return wasmModule.ease_in_cubic(t);
}

export function wasmValidateScrollState(
	width: number, scrollWidth: number, scrollLeft: number,
	height: number, scrollHeight: number, scrollTop: number,
	forceInt: boolean
): IWasmScrollState | null {
	if (!wasmModule) {
		return null;
	}
	const result = wasmModule.validate_scroll_state(width, scrollWidth, scrollLeft, height, scrollHeight, scrollTop, forceInt);
	const out: IWasmScrollState = {
		width: result.width,
		scrollWidth: result.scroll_width,
		scrollLeft: result.scroll_left,
		height: result.height,
		scrollHeight: result.scroll_height,
		scrollTop: result.scroll_top,
	};
	result.free();
	return out;
}

export function wasmSmoothScrollTick(
	now: number, startTime: number, duration: number,
	fromLeft: number, toLeft: number,
	fromTop: number, toTop: number,
	viewportWidth: number, viewportHeight: number
): IWasmSmoothScrollResult | null {
	if (!wasmModule) {
		return null;
	}
	const result = wasmModule.smooth_scroll_tick(now, startTime, duration, fromLeft, toLeft, fromTop, toTop, viewportWidth, viewportHeight);
	const out: IWasmSmoothScrollResult = {
		scrollLeft: result.scroll_left,
		scrollTop: result.scroll_top,
		isDone: result.is_done,
	};
	result.free();
	return out;
}

export function wasmInertialTick(
	speedX: number, speedY: number,
	decay: number, threshold: number
): IWasmInertialState | null {
	if (!wasmModule) {
		return null;
	}
	const result = wasmModule.inertial_tick(speedX, speedY, decay, threshold);
	const out: IWasmInertialState = {
		speedX: result.speed_x,
		speedY: result.speed_y,
		active: result.active,
	};
	result.free();
	return out;
}

export function wasmComputeScrollbarState(
	arrowSize: number, scrollbarSize: number, oppositeScrollbarSize: number,
	visibleSize: number, scrollSize: number, scrollPosition: number,
	minSliderSize: number
): IWasmScrollbarValues | null {
	if (!wasmModule) {
		return null;
	}
	const result = wasmModule.compute_scrollbar_state(arrowSize, scrollbarSize, oppositeScrollbarSize, visibleSize, scrollSize, scrollPosition, minSliderSize);
	const out: IWasmScrollbarValues = {
		sliderSize: result.slider_size,
		sliderPosition: result.slider_position,
		sliderRatio: result.slider_ratio,
	};
	result.free();
	return out;
}

export function wasmProcessWheelDelta(
	rawDeltaX: number, rawDeltaY: number,
	sensitivity: number, scrollPredominantAxis: boolean,
	flipAxes: boolean, scrollYToX: boolean,
	isShift: boolean, isAlt: boolean,
	fastSensitivity: number, isMac: boolean
): IWasmWheelDelta | null {
	if (!wasmModule) {
		return null;
	}
	const result = wasmModule.process_wheel_delta(
		rawDeltaX, rawDeltaY, sensitivity, scrollPredominantAxis,
		flipAxes, scrollYToX, isShift, isAlt, fastSensitivity, isMac
	);
	const out: IWasmWheelDelta = {
		deltaX: result.delta_x,
		deltaY: result.delta_y,
	};
	result.free();
	return out;
}

let wasmClassifier: any = null;

export function wasmClassifierAccept(timestamp: number, deltaX: number, deltaY: number): void {
	if (!wasmModule) {
		return;
	}
	if (!wasmClassifier) {
		wasmClassifier = new wasmModule.WheelClassifier();
	}
	wasmClassifier.accept(timestamp, deltaX, deltaY);
}

export function wasmClassifierIsPhysical(): boolean | null {
	if (!wasmModule || !wasmClassifier) {
		return null;
	}
	return wasmClassifier.is_physical_mouse_wheel();
}

export function isWasmReady(): boolean {
	return wasmModule !== null;
}
