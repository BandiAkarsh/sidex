/*---------------------------------------------------------------------------------------------
 *  SideX WASM Scroll Physics Bridge
 *  Loads the WASM scroll module and provides typed wrappers for the scroll engine.
 *--------------------------------------------------------------------------------------------*/

let wasmModule: any = null;
let initPromise: Promise<void> | null = null;
let initFailed = false;
let outBuf: Float64Array | null = null;

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
				const wasmPath = '/wasm/scroll/sidex_scroll_wasm.js';
				const mod = await import(/* @vite-ignore */ wasmPath);
				await mod.default();
				wasmModule = mod;
				const ptr = mod.get_output_ptr();
				outBuf = new Float64Array(mod.memory.buffer, ptr, 8);
			} catch (e) {
				console.warn('[SideX] WASM scroll module not available, using JS fallback', e);
				initFailed = true;
			}
		})();
	}
	await initPromise;
	return wasmModule;
}

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
	width: number,
	scrollWidth: number,
	scrollLeft: number,
	height: number,
	scrollHeight: number,
	scrollTop: number,
	forceInt: boolean
): IWasmScrollState | null {
	if (!wasmModule || !outBuf) {
		return null;
	}
	wasmModule.validate_scroll_state_flat(width, scrollWidth, scrollLeft, height, scrollHeight, scrollTop, forceInt);
	return {
		width: outBuf[0],
		scrollWidth: outBuf[1],
		scrollLeft: outBuf[2],
		height: outBuf[3],
		scrollHeight: outBuf[4],
		scrollTop: outBuf[5]
	};
}

export function wasmSmoothScrollTick(
	now: number,
	startTime: number,
	duration: number,
	fromLeft: number,
	toLeft: number,
	fromTop: number,
	toTop: number,
	viewportWidth: number,
	viewportHeight: number
): IWasmSmoothScrollResult | null {
	if (!wasmModule || !outBuf) {
		return null;
	}
	wasmModule.smooth_scroll_tick_flat(
		now,
		startTime,
		duration,
		fromLeft,
		toLeft,
		fromTop,
		toTop,
		viewportWidth,
		viewportHeight
	);
	return {
		scrollLeft: outBuf[0],
		scrollTop: outBuf[1],
		isDone: outBuf[2] !== 0
	};
}

export function wasmInertialTick(
	speedX: number,
	speedY: number,
	decay: number,
	threshold: number
): IWasmInertialState | null {
	if (!wasmModule || !outBuf) {
		return null;
	}
	wasmModule.inertial_tick_flat(speedX, speedY, decay, threshold);
	return {
		speedX: outBuf[0],
		speedY: outBuf[1],
		active: outBuf[2] !== 0
	};
}

export function wasmComputeScrollbarState(
	arrowSize: number,
	scrollbarSize: number,
	oppositeScrollbarSize: number,
	visibleSize: number,
	scrollSize: number,
	scrollPosition: number,
	minSliderSize: number
): IWasmScrollbarValues | null {
	if (!wasmModule || !outBuf) {
		return null;
	}
	wasmModule.compute_scrollbar_state_flat(
		arrowSize,
		scrollbarSize,
		oppositeScrollbarSize,
		visibleSize,
		scrollSize,
		scrollPosition,
		minSliderSize
	);
	return {
		sliderSize: outBuf[0],
		sliderPosition: outBuf[1],
		sliderRatio: outBuf[2]
	};
}

export function wasmProcessWheelDelta(
	rawDeltaX: number,
	rawDeltaY: number,
	sensitivity: number,
	scrollPredominantAxis: boolean,
	flipAxes: boolean,
	scrollYToX: boolean,
	isShift: boolean,
	isAlt: boolean,
	fastSensitivity: number,
	isMac: boolean
): IWasmWheelDelta | null {
	if (!wasmModule || !outBuf) {
		return null;
	}
	wasmModule.process_wheel_delta_flat(
		rawDeltaX,
		rawDeltaY,
		sensitivity,
		scrollPredominantAxis,
		flipAxes,
		scrollYToX,
		isShift,
		isAlt,
		fastSensitivity,
		isMac
	);
	return {
		deltaX: outBuf[0],
		deltaY: outBuf[1]
	};
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
