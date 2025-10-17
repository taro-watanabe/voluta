// @ts-nocheck
declare const acquireVsCodeApi: any;
const vscode = acquireVsCodeApi();

const elements = {
	curlInput: document.getElementById("curlInput"),
	curlOutput: document.getElementById("curlOutput"),
	executeButton: document.getElementById("executeButton"),
	executionOutput: document.getElementById("executionOutput"),
	statusBadgeContainer: document.getElementById("statusBadges"),
	durationLabel: document.getElementById("durationLabel"),
	addUrlParam: document.getElementById("addUrlParam"),
	urlParamsEditor: document.getElementById("urlParamsEditor"),
	addFormData: document.getElementById("addFormData"),
	formDataEditor: document.getElementById("formDataEditor"),
	saveOutputButton: document.getElementById("saveOutputButton"),
	toggleLoopButton: document.getElementById("toggleLoopButton"),
	loopToggleLabel: document.getElementById("loopToggleLabel"),
	toggleAdvancedButton: document.getElementById("toggleAdvancedButton"),
	advancedToggleLabel: document.getElementById("advancedToggleLabel"),
	loopSection: document.getElementById("loopSection"),
	staticTitle: document.getElementById("staticTitle"),
	loopControls: document.getElementById("loopControls"),
	loopContainer: document.getElementById("loopContainer"),
	addLoopButton: document.getElementById("addLoopButton"),
	loopGrouping: document.getElementById("loopGrouping"),
	independentList: document.getElementById("independentList"),
	syncedList: document.getElementById("syncedList"),
	loopGroupingMessage: document.getElementById("loopGroupingMessage"),
	loopProgress: document.getElementById("loopProgress"),
	loopHint: document.getElementById("loopHint"),
	loopDelayInput: document.getElementById("loopDelayInput"),
	advancedSection: document.getElementById("advancedSection"),
	advancedOptionsContainer: document.getElementById("advancedOptionsContainer"),
	addAdvancedFlag: document.getElementById("addAdvancedFlag"),
	routeSchemeInput: document.getElementById("routeSchemeInput"),
	routeSubdomainInput: document.getElementById("routeSubdomainInput"),
	routeDomainInput: document.getElementById("routeDomainInput"),
	routePortInput: document.getElementById("routePortInput"),
	routePathInput: document.getElementById("routePathInput"),
};

const LOOP_TARGET_OPTIONS = [
	{ value: "query", label: "Query Parameter" },
	{ value: "form", label: "Form Field" },
	{ value: "route", label: "Route Part" },
	{ value: "header", label: "cURL Header", requiresAdvanced: true },
];
const HEADER_FLAG_OPTIONS = [
	{ value: "-H", label: "-H (Header)", requiresName: true },
	{ value: "--header", label: "--header", requiresName: true },
	{ value: "-b", label: "-b (Cookie)", requiresName: false },
	{ value: "--cookie", label: "--cookie", requiresName: false },
];
const DEFAULT_HEADER_FLAG = HEADER_FLAG_OPTIONS[0].value;
const ROUTE_LOOP_KEYS = ["scheme", "subdomain", "domain", "port", "path"];
const ROUTE_LOOP_OPTIONS = [
	{ value: "scheme", label: "Protocol" },
	{ value: "subdomain", label: "Subdomain" },
	{ value: "domain", label: "Domain" },
	{ value: "port", label: "Port" },
	{ value: "path", label: "Base Path" },
];

const loopState = {
	loops: [],
	syncedLoopIds: [],
	isRunning: false,
	expectedTotalRuns: 0,
};

let draggedLoopId = null;
let latestCurlText = "";
let loopPanelExpanded = false;
let advancedExpanded = false;

restoreLoopState();
renderLoopEditor();
renderGrouping();
updateGroupingVisibility();
updateSaveButtonState();
updateLoopVisibility();
updateAdvancedVisibility();

let parseTimeout = null;

elements.curlInput.addEventListener("input", () => {
	if (parseTimeout) {
		clearTimeout(parseTimeout);
	}
	parseTimeout = setTimeout(() => {
		const curlCommand = elements.curlInput.value;
		vscode.postMessage({
			command: "parseCurl",
			text: curlCommand,
		});
	}, 300);
});

elements.executeButton.addEventListener("click", () => {
	if (loopState.isRunning) {
		return;
	}

	const loopConfig = buildLoopConfig();
	if (loopConfig && loopConfig.loops.length) {
		const validationError = validateLoopConfig(loopConfig);
		if (validationError) {
			showGroupingMessage(validationError, "error");
			return;
		}

		const totalRuns = estimateTotalRuns(loopConfig);
		if (!totalRuns || !Number.isFinite(totalRuns)) {
			showGroupingMessage("Loop configuration produces no runs.", "error");
			return;
		}

		showGroupingMessage("");
		loopState.expectedTotalRuns = totalRuns;
		loopPanelExpanded = true;
		updateLoopVisibility();
		setLoopRunningState(true);
		updateCurlPreview();
		updateLoopProgressMessage(0, totalRuns);

		const delayValue = Number(elements.loopDelayInput?.value ?? 0);
		const delay =
			Number.isFinite(delayValue) && delayValue > 0 ? delayValue : 0;

		vscode.postMessage({
			command: "executeLoop",
			text: JSON.stringify({
				...loopConfig,
				delay,
			}),
		});
	} else {
		showGroupingMessage("");
		const curlCommand = elements.curlOutput.value || latestCurlText;
		vscode.postMessage({
			command: "executeCurl",
			text: curlCommand,
		});
	}
});

elements.saveOutputButton.addEventListener("click", () => {
	const output = elements.executionOutput.textContent || "";
	vscode.postMessage({
		command: "saveOutput",
		text: output,
	});
});

elements.addUrlParam.addEventListener("click", () =>
	createParamRow("urlParamsEditor"),
);
elements.addFormData.addEventListener("click", () =>
	createParamRow("formDataEditor"),
);

elements.loopDelayInput?.addEventListener("input", () => {
	const value = Number(elements.loopDelayInput.value);
	if (!Number.isFinite(value) || value < 0) {
		elements.loopDelayInput.value = "0";
	}
});

elements.toggleLoopButton.addEventListener("change", () => {
	loopPanelExpanded = elements.toggleLoopButton.checked;
	if (loopPanelExpanded && !loopState.loops.length) {
		showGroupingMessage(
			"Loops enabled. Add a loop below to get started.",
			"info",
		);
	} else if (!loopPanelExpanded) {
		showGroupingMessage("");
	}
	updateLoopVisibility();
	if (loopPanelExpanded) {
		updateGroupingVisibility();
	}
});

elements.toggleAdvancedButton.addEventListener("change", () => {
	advancedExpanded = Boolean(
		(elements.toggleAdvancedButton as HTMLInputElement)?.checked,
	);
	updateAdvancedVisibility();
	renderLoopEditor();
	sendReconstructCurlCommand();
});

elements.addLoopButton?.addEventListener("click", () => {
	addLoop();
	showGroupingMessage("");
});

elements.addAdvancedFlag?.addEventListener("click", () => {
	addAdvancedFlagRow();
	sendReconstructCurlCommand();
});

elements.advancedOptionsContainer?.addEventListener("input", () => {
	sendReconstructCurlCommand();
});

[
	elements.routeSchemeInput,
	elements.routeSubdomainInput,
	elements.routeDomainInput,
	elements.routePortInput,
	elements.routePathInput,
].forEach((input) => {
	if (!input) {
		return;
	}
	input.addEventListener("input", handleRouteInputChange);
	input.addEventListener("blur", handleRouteInputBlur);
});

[elements.independentList, elements.syncedList].forEach((zone) => {
	zone.addEventListener("dragover", (event) => {
		if (!draggedLoopId || loopState.isRunning) {
			return;
		}
		event.preventDefault();
		zone.classList.add("drag-over");
	});
	zone.addEventListener("dragleave", () => {
		zone.classList.remove("drag-over");
	});
	zone.addEventListener("drop", (event) => {
		if (!draggedLoopId || loopState.isRunning) {
			zone.classList.remove("drag-over");
			return;
		}
		event.preventDefault();
		const loopId = draggedLoopId || event.dataTransfer?.getData("text/plain");
		zone.classList.remove("drag-over");
		if (!loopId) {
			return;
		}
		handleLoopDrop(loopId, zone.dataset.zone);
	});
});

window.addEventListener("message", (event) => {
	const message = event.data;
	switch (message.command) {
		case "updateParsedCurl":
			renderParsedData(JSON.parse(message.text));
			break;
		case "updateReconstructedCurl":
			latestCurlText = message.text;
			updateCurlPreview();
			break;
		case "updateExecutionOutput":
			updateExecutionOutput(message);
			break;
		case "loopProgress":
			updateLoopProgress(message);
			break;
		case "loopComplete":
			handleLoopComplete(message);
			break;
	}
});

function handleRouteInputChange() {
	sendReconstructCurlCommand();
}

function handleRouteInputBlur(event) {
	const target = event?.target;
	if (!target) {
		return;
	}
	if (target === elements.routeSchemeInput) {
		target.value = target.value.trim().toLowerCase();
	}
	if (target === elements.routeSubdomainInput || target === elements.routeDomainInput) {
		target.value = target.value.trim();
	}
	if (target === elements.routePortInput) {
		target.value = target.value.trim();
	}
	if (target === elements.routePathInput) {
		target.value = normalizeRoutePath(target.value);
	}
	sendReconstructCurlCommand();
}

function collectRouteParts() {
	const schemeRaw = elements.routeSchemeInput?.value ?? "";
	const subdomainRaw = elements.routeSubdomainInput?.value ?? "";
	const domainRaw = elements.routeDomainInput?.value ?? "";
	const portRaw = elements.routePortInput?.value ?? "";
	const pathRaw = elements.routePathInput?.value ?? "";

	return {
		scheme: schemeRaw.trim().toLowerCase(),
		subdomain: subdomainRaw.trim(),
		domain: domainRaw.trim(),
		port: portRaw.trim(),
		path: normalizeRoutePath(pathRaw),
	};
}

function applyRouteParts(route) {
	const scheme = route?.scheme ?? '';
	const subdomain = route?.subdomain ?? '';
	const domain = route?.domain ?? '';
	const port = route?.port ?? '';
	const path = route?.path ?? '';

	if (elements.routeSchemeInput) {
		elements.routeSchemeInput.value = scheme || 'https';
	}
	if (elements.routeSubdomainInput) {
		elements.routeSubdomainInput.value = subdomain;
	}
	if (elements.routeDomainInput) {
		elements.routeDomainInput.value = domain;
	}
	if (elements.routePortInput) {
		elements.routePortInput.value = port;
	}
	if (elements.routePathInput) {
		elements.routePathInput.value = normalizeRoutePath(path);
	}
}

function parseRouteFromUrl(url) {
	const empty = { scheme: '', subdomain: '', domain: '', port: '', path: '' };
	if (!url) {
		return empty;
	}
	let candidate = url;
	try {
		new URL(candidate);
	} catch {
		try {
			candidate = `https://${url.replace(/^\/+/g, '')}`;
			new URL(candidate);
		} catch {
			return empty;
		}
	}
	try {
		const parsed = new URL(candidate);
		const route = { ...empty };
		route.scheme = parsed.protocol.replace(':', '');
		const hostname = parsed.hostname;
		if (hostname) {
			const parts = hostname.split('.');
			if (parts.length <= 2) {
				route.domain = hostname;
				route.subdomain = '';
			} else {
				route.subdomain = parts[0];
				route.domain = parts.slice(1).join('.');
			}
		}
		route.port = parsed.port;
		const pathname = parsed.pathname.replace(/^\/+/g, '').replace(/\/+/g, '/');
		route.path = pathname.replace(/\/$/g, '');
		return route;
	} catch {
		return empty;
	}
}

function normalizeRoutePath(value) {
	if (!value) {
		return '';
	}
	return value
		.trim()
		.replace(/^\/+/g, '')
		.replace(/\/+/g, '/')
		.replace(/\/$/g, '');
}

function normalizeRouteTargetKey(value) {
	const trimmed = (value ?? '').trim().toLowerCase();
	return ROUTE_LOOP_KEYS.includes(trimmed) ? trimmed : '';
}

function inferStatusBadgeType(statusText, statusLabel) {
	const normalizedLabel = (statusLabel ?? '').toLowerCase();
	if (normalizedLabel === 'error') {
		return 'error';
	}
	if (normalizedLabel === 'success') {
		return 'success';
	}
	const normalizedStatus = (statusText ?? '').toLowerCase();
	const numericStatus = Number(statusText);
	if (!Number.isNaN(numericStatus)) {
		if (numericStatus >= 200 && numericStatus < 300) {
			return 'success';
		}
		if (numericStatus >= 400 || numericStatus === 0) {
			return 'error';
		}
	}
	if (normalizedStatus === 'error' || normalizedStatus === 'err') {
		return 'error';
	}
	if (normalizedStatus === 'success') {
		return 'success';
	}
	if (normalizedLabel === 'info') {
		return 'info';
	}
	return 'info';
}

function buildBadgesFromSummary(summary) {
	const badges = [];
	if (!summary || typeof summary !== 'string') {
		return badges;
	}
	const regex = /\(([^)]+)\)\s*×(\d+)/g;
	let match;
	while ((match = regex.exec(summary)) !== null) {
		const statusText = match[1].trim();
		const count = Number(match[2]);
		if (!count) {
			continue;
		}
		const type = inferStatusBadgeType(statusText, undefined);
		const isErrorCode =
			type === 'error' &&
			(statusText === '0' || statusText.toLowerCase() === 'error' || statusText.toLowerCase() === 'err');
		const text = `${isErrorCode ? 'ERROR' : statusText} ×${count}`;
		badges.push({ text, type });
	}
	return badges;
}

function renderStatusBadges(badges) {
	const container = elements.statusBadgeContainer;
	if (!container) {
		return;
	}
	container.innerHTML = '';
	if (!badges || !badges.length) {
		container.hidden = true;
		return;
	}
	container.hidden = false;
	badges.forEach((badge) => {
		const span = document.createElement('span');
		span.className = `status-badge ${badge.type}`;
		span.textContent = badge.text;
		container.appendChild(span);
	});
}

function sendReconstructCurlCommand() {
	const currentParsedData = {
		query: {},
		data: {},
		route: collectRouteParts(),
		flags: collectAdvancedFlags(),
	};

	document.querySelectorAll("#urlParamsEditor .param-row").forEach((row) => {
		const keyInput = row.querySelector(".param-key");
		const valueInput = row.querySelector(".param-value");
		if (keyInput && valueInput && keyInput.value) {
			currentParsedData.query[keyInput.value] = valueInput.value;
		}
	});

	document.querySelectorAll("#formDataEditor .param-row").forEach((row) => {
		const keyInput = row.querySelector(".param-key");
		const valueInput = row.querySelector(".param-value");
		if (keyInput && valueInput && keyInput.value) {
			currentParsedData.data[keyInput.value] = valueInput.value;
		}
	});

	vscode.postMessage({
		command: "reconstructCurl",
		text: JSON.stringify(currentParsedData),
	});
}

function createParamRow(containerId, key = "", value = "") {
	const container = document.getElementById(containerId);
	const row = document.createElement("div");
	row.className = "param-row";
	const keyInput = document.createElement("input");
	keyInput.type = "text";
	keyInput.className = "param-key";
	keyInput.value = key;
	keyInput.placeholder = "Key";

	const valueInput = document.createElement("input");
	valueInput.type = "text";
	valueInput.className = "param-value";
	valueInput.value = value;
	valueInput.placeholder = "Value";

	const convertButton = document.createElement("button");
	convertButton.type = "button";
	convertButton.className = "convert-loop";
	convertButton.textContent = "→ Loop";
	convertButton.title =
		"Convert this parameter into a loop to run multiple requests with different values.";
	convertButton.addEventListener("click", () => {
		const targetType = containerId === "formDataEditor" ? "form" : "query";
		const targetKey = keyInput.value.trim();
		const loopValue = valueInput.value;
		if (!targetKey) {
			showGroupingMessage(
				"Provide a key before converting to a loop.",
				"error",
			);
			return;
		}
		addLoop({
			targetType,
			targetKey,
			rawText: loopValue ? String(loopValue) : "",
			values: loopValue ? [parseLoopValue(String(loopValue))] : [],
		});
		loopPanelExpanded = true;
		updateLoopVisibility();
		row.remove();
		sendReconstructCurlCommand();
		showGroupingMessage("");
	});

	const removeButton = document.createElement("button");
	removeButton.type = "button";
	removeButton.className = "remove-param";
	removeButton.textContent = "X";
	removeButton.addEventListener("click", () => {
		row.remove();
		sendReconstructCurlCommand();
	});

	row.appendChild(keyInput);
	row.appendChild(valueInput);
	row.appendChild(convertButton);
	row.appendChild(removeButton);
	container.appendChild(row);

	keyInput.addEventListener("input", sendReconstructCurlCommand);
	valueInput.addEventListener("input", sendReconstructCurlCommand);
}

function renderParsedData(parsedData) {
	elements.urlParamsEditor.innerHTML = "";
	elements.formDataEditor.innerHTML = "";

	if (parsedData.query) {
		for (const key in parsedData.query) {
			createParamRow("urlParamsEditor", key, parsedData.query[key]);
		}
	}

	if (parsedData.data && typeof parsedData.data === "object") {
		for (const key in parsedData.data) {
			createParamRow("formDataEditor", key, parsedData.data[key]);
		}
	}

	const routeParts = parsedData.route || parseRouteFromUrl(parsedData.url || "");
	applyRouteParts(routeParts);

	const parsedFlags = Array.isArray(parsedData.flags) ? parsedData.flags : [];
	renderAdvancedFlags(parsedFlags);
	if (elements.toggleAdvancedButton) {
		(elements.toggleAdvancedButton as HTMLInputElement).checked =
			advancedExpanded;
	}
	updateAdvancedVisibility();

	sendReconstructCurlCommand();
}

function updateExecutionOutput(message) {
	elements.executionOutput.textContent = message.text ?? "";
	updateSaveButtonState();

	const badges = [];
	const statusLabel = typeof message.statusLabel === "string" ? message.statusLabel : undefined;
	let numericStatus;
	if (typeof message.status === "number") {
		numericStatus = message.status;
	} else if (
		typeof message.status === "string" &&
		message.status.trim().length &&
		!Number.isNaN(Number(message.status))
	) {
		numericStatus = Number(message.status);
	}
	const labelIsError = typeof statusLabel === "string" && statusLabel.toLowerCase() === "error";
	const forceErrorBadge =
		labelIsError && (numericStatus === undefined || Number.isNaN(numericStatus) || numericStatus === 0);

	if (forceErrorBadge) {
		badges.push({ text: "ERROR", type: "error" });
	} else if (message.status !== undefined && message.status !== null) {
		const text = String(message.status);
		const type = inferStatusBadgeType(text, statusLabel);
		const displayText =
			type === "error" &&
			(text === "0" || text.toLowerCase() === "error" || text.toLowerCase() === "err")
				? "ERROR"
				: text;
		badges.push({ text: displayText, type });
	} else if (statusLabel) {
		const type = inferStatusBadgeType(undefined, statusLabel);
		badges.push({ text: statusLabel.toUpperCase(), type });
	}

	renderStatusBadges(badges);

	if (message.duration !== undefined) {
		elements.durationLabel.textContent = `${message.duration} ms`;
		elements.durationLabel.hidden = false;
	} else {
		elements.durationLabel.hidden = true;
	}
}

function updateSaveButtonState() {
	const hasContent =
		(elements.executionOutput.textContent || "").trim().length > 0;
	elements.saveOutputButton.disabled = !hasContent;
}

function renderLoopEditor() {
	pruneSyncedLoopIds();

	elements.loopContainer.innerHTML = "";

	if (!loopState.loops.length) {
		const empty = document.createElement("p");
		empty.className = "hint";
		empty.textContent = "No loop fields configured yet.";
		elements.loopContainer.appendChild(empty);
		updateGroupingVisibility();
		persistLoopState();
		updateCurlPreview();
		return;
	}

	loopState.loops.forEach((loop) => {
		const block = document.createElement("div");
		block.className = "loop-block";
		block.dataset.loopId = loop.id;

		const header = document.createElement("div");
		header.className = "loop-block-header";
		let targetKeyInput: HTMLInputElement;
		let routeKeySelect: HTMLSelectElement;

		const targetSelect = document.createElement("select");
		targetSelect.disabled = loopState.isRunning;
		const availableOptions = getLoopTargetOptions(loop.targetType);
		if (!availableOptions.some((option) => option.value === loop.targetType)) {
			loop.targetType = normalizeLoopTargetType(loop.targetType);
			loop.targetFlag = normalizeLoopFlag(loop.targetType, loop.targetFlag);
		}
		availableOptions.forEach((option) => {
			const opt = document.createElement("option");
			opt.value = option.value;
			opt.textContent = option.label;
			if (loop.targetType === option.value) {
				opt.selected = true;
			}
			targetSelect.appendChild(opt);
		});
		const flagInput = document.createElement("input");
		flagInput.type = "text";
		flagInput.className = "loop-header-flag";
		flagInput.placeholder = "Flag (e.g., -H)";
		loop.targetFlag = normalizeLoopFlag(loop.targetType, loop.targetFlag);
		flagInput.value = loop.targetFlag || DEFAULT_HEADER_FLAG;
		const updateFlagState = () => {
			if (loop.targetType !== "header") {
				loop.targetFlag = undefined;
				return;
			}
			const normalized = normalizeLoopFlag("header", flagInput.value);
			loop.targetFlag = normalized;
			if (flagInput.value !== normalized) {
				flagInput.value = normalized;
			}
			if (targetKeyInput) {
				targetKeyInput.placeholder = resolveLoopPlaceholder(
					loop.targetType,
					loop.targetFlag,
				);
			}
			persistLoopState();
			renderGrouping();
			updateCurlPreview();
		};
		flagInput.hidden = loop.targetType !== "header";
		flagInput.disabled = loopState.isRunning || loop.targetType !== "header";
		flagInput.title = "Flag to use when emitting this looped header.";
		flagInput.addEventListener("input", () => {
			if (loop.targetType === "header") {
				loop.targetFlag = flagInput.value;
			}
		});
		flagInput.addEventListener("blur", updateFlagState);

		targetKeyInput = document.createElement("input");
		targetKeyInput.type = "text";
		targetKeyInput.placeholder = resolveLoopPlaceholder(
			loop.targetType,
			loop.targetFlag,
		);
		targetKeyInput.value = loop.targetKey || "";
		targetKeyInput.className = "loop-target-key";
		targetKeyInput.disabled = loopState.isRunning;

		routeKeySelect = document.createElement("select");
		routeKeySelect.className = "loop-route-key-select";
		ROUTE_LOOP_OPTIONS.forEach((option) => {
			const opt = document.createElement("option");
			opt.value = option.value;
			opt.textContent = option.label;
			routeKeySelect.appendChild(opt);
		});
		routeKeySelect.addEventListener("change", () => {
			if (loop.targetType !== "route") {
				return;
			}
			loop.targetKey = routeKeySelect.value;
			targetKeyInput.value = loop.targetKey;
			persistLoopState();
			showGroupingMessage("");
		});

		const syncRouteControls = () => {
			routeKeySelect.hidden = loop.targetType !== "route";
			routeKeySelect.disabled = loopState.isRunning || loop.targetType !== "route";
			if (loop.targetType === "route") {
				const normalized = normalizeRouteTargetKey(loop.targetKey) || "path";
				loop.targetKey = normalized;
				routeKeySelect.value = normalized;
				targetKeyInput.value = normalized;
				targetKeyInput.hidden = true;
			} else {
				targetKeyInput.hidden = false;
			}
		};

		targetKeyInput.addEventListener("input", (event) => {
			const value = event.target.value;
			if (loop.targetType === "route") {
				loop.targetKey = value.toLowerCase();
			} else {
				loop.targetKey = value;
			}
			persistLoopState();
		});
		targetKeyInput.addEventListener("blur", () => {
			if (loop.targetType !== "route") {
				return;
			}
			const normalized = normalizeRouteTargetKey(targetKeyInput.value);
			if (!normalized) {
				const fallbackKey = normalizeRouteTargetKey(loop.targetKey ?? "") || "path";
				targetKeyInput.value = fallbackKey;
				routeKeySelect.value = fallbackKey;
				loop.targetKey = fallbackKey;
				showGroupingMessage(
					'Route loops support "Protocol", "Subdomain", "Domain", "Port", or "Base Path".',
					"error",
				);
			} else {
				loop.targetKey = normalized;
				targetKeyInput.value = normalized;
				routeKeySelect.value = normalized;
				showGroupingMessage("");
			}
			persistLoopState();
		});

		targetSelect.addEventListener("change", () => {
			loop.targetType = targetSelect.value;
			loop.targetFlag = normalizeLoopFlag(loop.targetType, loop.targetFlag);
			targetKeyInput.placeholder = resolveLoopPlaceholder(
				loop.targetType,
				loop.targetFlag,
			);
			flagInput.hidden = loop.targetType !== "header";
			flagInput.disabled = loopState.isRunning || loop.targetType !== "header";
			if (!flagInput.hidden) {
				flagInput.value = loop.targetFlag || DEFAULT_HEADER_FLAG;
				updateFlagState();
			}
			syncRouteControls();
			persistLoopState();
			renderGrouping();
			updateCurlPreview();
		});

		syncRouteControls();

		header.appendChild(targetSelect);
		header.appendChild(flagInput);
		header.appendChild(routeKeySelect);
		header.appendChild(targetKeyInput);

		const body = document.createElement("div");

		const valuesTextarea = document.createElement("textarea");
		valuesTextarea.className = "loop-values-input";
		valuesTextarea.placeholder = "One value per line";
		valuesTextarea.value =
			loop.rawText ?? loop.values.map(valueToLine).join("\n");
		valuesTextarea.disabled = loopState.isRunning;
		valuesTextarea.addEventListener("input", (event) => {
			loop.rawText = event.target.value;
		});
		valuesTextarea.addEventListener("blur", (event) => {
			applyLoopText(loop, event.target.value, lengthBadge);
		});
		body.appendChild(valuesTextarea);

		const footer = document.createElement("div");
		footer.className = "loop-block-footer";

		const fileLabel = document.createElement("label");
		fileLabel.className = "file-upload-label";
		fileLabel.textContent = "Load File";
		const fileInput = document.createElement("input");
		fileInput.type = "file";
		fileInput.accept = ".txt,.json";
		fileInput.disabled = loopState.isRunning;
		fileInput.addEventListener("change", (event) => {
			const file = event.target.files?.[0];
			if (!file) {
				return;
			}
			const reader = new FileReader();
			reader.onload = () => {
				const text = typeof reader.result === "string" ? reader.result : "";
				valuesTextarea.value = text;
				applyLoopText(loop, text, lengthBadge);
				event.target.value = "";
			};
			reader.readAsText(file);
		});
		fileLabel.appendChild(fileInput);
		footer.appendChild(fileLabel);

		const lengthBadge = document.createElement("span");
		lengthBadge.className = "loop-length";
		lengthBadge.textContent = formatLoopLength(loop.values.length);
		footer.appendChild(lengthBadge);

		const removeButton = document.createElement("button");
		removeButton.type = "button";
		removeButton.className = "remove-loop-btn";
		removeButton.textContent = "×";
		removeButton.disabled = loopState.isRunning;
		removeButton.title = "Remove this loop";
		removeButton.addEventListener("click", () => {
			removeLoop(loop.id);
		});
		footer.appendChild(removeButton);

		block.appendChild(header);
		block.appendChild(body);
		block.appendChild(footer);

		elements.loopContainer.appendChild(block);
	});

	updateGroupingVisibility();
	persistLoopState();
	updateCurlPreview();
}

function addLoop(initialLoop) {
	const normalizedType = normalizeLoopTargetType(initialLoop?.targetType);
	const loop = {
		id: initialLoop?.id || generateLoopId(),
		name: initialLoop?.name || "",
		targetType: normalizedType,
		targetFlag: normalizeLoopFlag(normalizedType, initialLoop?.targetFlag),
		targetKey: initialLoop?.targetKey || "",
		rawText: initialLoop?.rawText || "",
		values: Array.isArray(initialLoop?.values) ? initialLoop.values : [],
	};
	if (!loop.values.length && loop.rawText) {
		const parsed = parseLoopText(loop.rawText);
		loop.values = parsed.values;
	}
	loopState.loops.push(loop);
	loopPanelExpanded = true;
	renderLoopEditor();
	renderGrouping();
	updateGroupingVisibility();
	persistLoopState();
	updateLoopVisibility();
}

function removeLoop(loopId) {
	loopState.loops = loopState.loops.filter((loop) => loop.id !== loopId);
	loopState.syncedLoopIds = loopState.syncedLoopIds.filter(
		(id) => id !== loopId,
	);
	if (!loopState.loops.length) {
		loopPanelExpanded = false;
	}
	renderLoopEditor();
	renderGrouping();
	updateGroupingVisibility();
	persistLoopState();
	updateLoopVisibility();
}

function applyLoopText(loop, text, lengthBadge) {
	loop.rawText = text;
	const parsed = parseLoopText(text);
	loop.values = parsed.values;
	if (lengthBadge) {
		lengthBadge.textContent = formatLoopLength(loop.values.length);
	}
	ensureSyncedConsistency();
	renderGrouping();
	persistLoopState();
	updateCurlPreview();
}

function parseLoopText(text) {
	const lines = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);

	const values = lines.map(parseLoopValue);
	return { values };
}

function parseLoopValue(line) {
	if (!line.length) {
		return "";
	}
	if (
		(line.startsWith('"') && line.endsWith('"')) ||
		(line.startsWith("'") && line.endsWith("'"))
	) {
		return line.slice(1, -1);
	}
	try {
		return JSON.parse(line);
	} catch {
		return line;
	}
}

function valueToLine(value) {
	if (typeof value === "string") {
		return value;
	}
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function formatLoopLength(length) {
	return `${length} item${length === 1 ? "" : "s"}`;
}

function renderGrouping() {
	ensureSyncedConsistency();
	elements.independentList.innerHTML = "";
	elements.syncedList.innerHTML = "";

	const independentLoops = loopState.loops.filter(
		(loop) => !loopState.syncedLoopIds.includes(loop.id),
	);
	independentLoops.forEach((loop) => {
		elements.independentList.appendChild(createLoopChip(loop));
	});

	loopState.syncedLoopIds.forEach((loopId) => {
		const loop = loopState.loops.find((item) => item.id === loopId);
		if (loop) {
			elements.syncedList.appendChild(createLoopChip(loop));
		}
	});
	updateCurlPreview();
}

function createLoopChip(loop) {
	const chip = document.createElement("div");
	chip.className = "loop-chip";
	chip.draggable = !loopState.isRunning;
	chip.dataset.loopId = loop.id;
	const label = loop.name
		? loop.name
		: loop.targetType === "header"
		?	loop.targetFlag || "Header"
		: loop.targetType === "route"
		?	`Route:${normalizeRouteTargetKey(loop.targetKey) || "path"}`
		: loop.targetKey || "Loop";
	chip.textContent = `${label} (${loop.values.length})`;
	chip.addEventListener("dragstart", handleDragStart);
	chip.addEventListener("dragend", handleDragEnd);
	return chip;
}

function handleDragStart(event) {
	if (loopState.isRunning) {
		event.preventDefault();
		return;
	}
	const target = event.currentTarget;
	draggedLoopId = target.dataset.loopId || null;
	event.dataTransfer?.setData("text/plain", draggedLoopId || "");
	target.classList.add("dragging");
}

function handleDragEnd(event) {
	draggedLoopId = null;
	event.currentTarget.classList.remove("dragging");
}

function handleLoopDrop(loopId, targetZone) {
	const loop = loopState.loops.find((item) => item.id === loopId);
	if (!loop) {
		return;
	}

	if (targetZone === "synced") {
		if (loop.values.length === 0) {
			showGroupingMessage("Cannot synchronize an empty loop.", "error");
			return;
		}
		const syncedLoops = loopState.syncedLoopIds
			.map((id) => loopState.loops.find((item) => item.id === id))
			.filter(Boolean);
		if (syncedLoops.length > 0) {
			const referenceLength = syncedLoops[0].values.length;
			if (referenceLength !== loop.values.length) {
				showGroupingMessage(
					"Synchronized loops must have identical lengths.",
					"error",
				);
				return;
			}
		}
		if (!loopState.syncedLoopIds.includes(loop.id)) {
			loopState.syncedLoopIds.push(loop.id);
		}
		showGroupingMessage("");
	} else {
		loopState.syncedLoopIds = loopState.syncedLoopIds.filter(
			(id) => id !== loop.id,
		);
		showGroupingMessage("");
	}
	renderGrouping();
	persistLoopState();
	updateLoopVisibility();
}

function updateGroupingVisibility() {
	const shouldShow = loopState.loops.length >= 2;
	elements.loopGrouping.hidden = !shouldShow;
	if (!shouldShow) {
		loopState.syncedLoopIds = [];
		elements.loopGroupingMessage.textContent = "";
	}
}

function ensureSyncedConsistency() {
	if (!loopState.syncedLoopIds.length) {
		return;
	}
	const syncedLoops = loopState.syncedLoopIds
		.map((id) => loopState.loops.find((loop) => loop.id === id))
		.filter(Boolean);
	if (!syncedLoops.length) {
		loopState.syncedLoopIds = [];
		return;
	}
	const referenceLength = syncedLoops[0].values.length;
	const mismatch = syncedLoops.some(
		(loop) => loop.values.length !== referenceLength,
	);
	if (mismatch) {
		loopState.syncedLoopIds = [];
		showGroupingMessage(
			"Reset synchronized loops because lengths no longer match.",
			"error",
		);
	}
}

function pruneSyncedLoopIds() {
	loopState.syncedLoopIds = loopState.syncedLoopIds.filter((id) =>
		loopState.loops.some((loop) => loop.id === id),
	);
}

function showGroupingMessage(text, type = "info") {
	elements.loopGroupingMessage.textContent = text || "";
	elements.loopGroupingMessage.classList.toggle(
		"error",
		type === "error" && !!text,
	);
}

function updateLoopVisibility() {
	const hasLoops = loopState.loops.length > 0;
	if (!elements.loopControls) {
		return;
	}
	if (!loopPanelExpanded && !hasLoops) {
		if (elements.staticTitle) {
			elements.staticTitle.textContent = "Parameters";
		}
		if (elements.loopSection) {
			elements.loopSection.hidden = true;
		}
		elements.loopControls.hidden = true;
		elements.loopGrouping.hidden = true;
		elements.loopProgress.hidden = true;
		elements.toggleLoopButton.checked = false;
		if (elements.loopToggleLabel) {
			elements.loopToggleLabel.textContent = "Loops Off";
		}
		if (elements.loopHint) {
			elements.loopHint.hidden = false;
		}
		if (elements.loopDelayInput) {
			elements.loopDelayInput.value = "0";
			elements.loopDelayInput.disabled = true;
		}
		return;
	}

	if (elements.staticTitle) {
		elements.staticTitle.textContent = loopPanelExpanded
			? "Static Parameters"
			: "Parameters";
	}
	if (elements.loopSection) {
		elements.loopSection.hidden = !loopPanelExpanded;
	}
	elements.loopControls.hidden = !loopPanelExpanded;
	if (elements.loopHint) {
		elements.loopHint.hidden = !loopPanelExpanded;
	}
	if (!loopPanelExpanded) {
		elements.loopGrouping.hidden = true;
		elements.loopProgress.hidden = true;
	}
	elements.toggleLoopButton.checked = loopPanelExpanded;
	if (elements.loopToggleLabel) {
		elements.loopToggleLabel.textContent = loopPanelExpanded
			? "Loops On"
			: "Loops Off";
	}
	if (elements.loopDelayInput) {
		elements.loopDelayInput.disabled =
			loopState.isRunning || !loopPanelExpanded;
	}

	updateAdvancedVisibility();
}

function updateAdvancedVisibility() {
	if (!elements.advancedSection) {
		return;
	}

	elements.advancedSection.hidden = !advancedExpanded;
	elements.toggleAdvancedButton.checked = advancedExpanded;
	if (elements.advancedToggleLabel) {
		elements.advancedToggleLabel.textContent = advancedExpanded
			? "Advanced Options On"
			: "Advanced Options Off";
	}

	if (
		advancedExpanded &&
		elements.advancedOptionsContainer?.childElementCount === 0
	) {
		addAdvancedFlagRow();
	}

	sendReconstructCurlCommand();
}

function buildLoopConfig() {
	if (!loopState.loops.length) {
		return null;
	}
	return {
		loops: loopState.loops.map((loop) => {
			const sanitizedFlag = normalizeLoopFlag(loop.targetType, loop.targetFlag);
			if (loop.targetType === "header") {
				loop.targetFlag = sanitizedFlag;
			}
			if (loop.targetType === "route") {
				loop.targetKey = normalizeRouteTargetKey(loop.targetKey) || "path";
			}
			return {
				id: loop.id,
				name: loop.name || loop.targetKey || loop.id,
				targetType: loop.targetType,
				targetFlag: sanitizedFlag,
				targetKey: loop.targetKey,
				values: loop.values,
			};
		}),
		syncedLoopIds: [...loopState.syncedLoopIds],
		flags: collectAdvancedFlags(),
	};
}

function validateLoopConfig(config) {
	if (!config || !config.loops || !config.loops.length) {
		return "";
	}

	for (const loop of config.loops) {
		if (loop.targetType === "header" && !loop.targetFlag) {
			return `Loop "${loop.name || loop.targetKey || loop.id}" needs a header flag.`;
		}
		if (loop.targetType === "route") {
			const normalizedRouteKey = normalizeRouteTargetKey(loop.targetKey ?? "");
			if (!normalizedRouteKey) {
				return `Loop "${loop.name || loop.id}" must target scheme, subdomain, domain, port, or path.`;
			}
			loop.targetKey = normalizedRouteKey;
		}
		const requiresKey =
			loop.targetType !== "header" || headerFlagRequiresName(loop.targetFlag);
		if (requiresKey && !loop.targetKey.trim()) {
			return `Loop "${loop.name || loop.id}" needs a target key.`;
		}
		if (!loop.values || !loop.values.length) {
			return `Loop "${loop.name || loop.targetKey || loop.id}" has no values.`;
		}
	}

	if (config.syncedLoopIds && config.syncedLoopIds.length > 0) {
		const loopMap = new Map(config.loops.map((loop) => [loop.id, loop]));
		const syncedLoops = config.syncedLoopIds
			.map((id) => loopMap.get(id))
			.filter(Boolean);
		if (syncedLoops.length > 0) {
			const reference = syncedLoops[0].values.length;
			const mismatch = syncedLoops.some(
				(loop) => loop.values.length !== reference,
			);
			if (mismatch) {
				return "Synchronized loops must have identical lengths.";
			}
		}
	}

	return "";
}

function estimateTotalRuns(config) {
	if (!config || !config.loops || !config.loops.length) {
		return 0;
	}
	const loopMap = new Map(config.loops.map((loop) => [loop.id, loop]));
	const syncedIds = config.syncedLoopIds.filter((id) => loopMap.has(id));
	let total = 1;
	if (syncedIds.length) {
		const first = loopMap.get(syncedIds[0]);
		total *= first?.values?.length || 0;
	}
	const independentLoops = config.loops.filter(
		(loop) => !syncedIds.includes(loop.id),
	);
	for (const loop of independentLoops) {
		total *= loop.values?.length || 0;
	}
	return total;
}

function setLoopRunningState(isRunning) {
	loopState.isRunning = isRunning;
	elements.addLoopButton.disabled = isRunning;
	elements.executeButton.disabled = isRunning;
	elements.executeButton.textContent = isRunning
		? "Executing loops…"
		: "Execute cURL";
	renderLoopEditor();
	renderGrouping();
	updateLoopVisibility();
	if (elements.loopDelayInput) {
		elements.loopDelayInput.disabled = isRunning || !loopPanelExpanded;
	}
	if (isRunning) {
		renderStatusBadges([]);
	}
}

function updateCurlPreview() {
	if (!latestCurlText) {
		elements.curlOutput.value = latestCurlText;
		return;
	}

	const config = buildLoopConfig();
	if (config && config.loops.length) {
		const validationError = validateLoopConfig(config);
		if (!validationError) {
			const total = estimateTotalRuns(config);
			if (total > 0) {
				elements.curlOutput.value = `1st out of ${total}: ${latestCurlText}`;
				return;
			}
		}
	}

	elements.curlOutput.value = latestCurlText;
}

function updateLoopProgress(message) {
	const total = message.total ?? loopState.expectedTotalRuns;
	const current = message.current ?? 0;
	const statusText =
		message.status !== undefined ? ` • Last status: ${message.status}` : "";
	updateLoopProgressMessage(current, total, statusText);
}

function updateLoopProgressMessage(current, total, statusText = "") {
	if (!total) {
		elements.loopProgress.hidden = true;
		elements.loopProgress.textContent = "";
		return;
	}
	elements.loopProgress.hidden = false;
	if (!current) {
		elements.loopProgress.textContent = `Preparing ${total} loop run${total === 1 ? "" : "s"}…`;
	} else {
		elements.loopProgress.textContent = `Completed ${current} of ${total} run${total === 1 ? "" : "s"}${statusText}`;
	}
}

function handleLoopComplete(message) {
	setLoopRunningState(false);
	loopState.expectedTotalRuns = 0;
	updateCurlPreview();
	if (message?.error) {
		elements.loopProgress.hidden = false;
		elements.loopProgress.textContent =
			"Loop execution finished with an error.";
		showGroupingMessage(message.error, "error");
		renderStatusBadges([{ text: "ERROR", type: "error" }]);
		return;
	}
	showGroupingMessage("");
	if (typeof message?.total === "number") {
		const success = message.successCount ?? 0;
		const failure = message.failureCount ?? 0;
		const summaries = [
			`Finished ${message.total} loop run${message.total === 1 ? "" : "s"}.`,
		];
		if (success || failure) {
			summaries.push(`Success: ${success}, Failures: ${failure}`);
		}
		if (message.statusSummary) {
			const summaryBadges = buildBadgesFromSummary(message.statusSummary);
			if (summaryBadges.length) {
				renderStatusBadges(summaryBadges);
			} else if (failure > 0) {
				renderStatusBadges([{ text: `ERROR ×${failure}`, type: "error" }]);
			} else if (success > 0) {
				renderStatusBadges([{ text: `200 ×${success}`, type: "success" }]);
			} else {
				renderStatusBadges([]);
			}
			summaries.push(message.statusSummary);
		} else if (failure > 0) {
			renderStatusBadges([{ text: `ERROR ×${failure}`, type: "error" }]);
		} else if (success > 0) {
			renderStatusBadges([{ text: `200 ×${success}`, type: "success" }]);
		} else {
			renderStatusBadges([]);
		}
		elements.loopProgress.hidden = false;
		elements.loopProgress.textContent = summaries.join(" ");
	} else {
		elements.loopProgress.hidden = true;
		elements.loopProgress.textContent = "";
		renderStatusBadges([]);
	}
}

function persistLoopState() {}

function restoreLoopState() {
	loopState.loops = [];
	loopState.syncedLoopIds = [];
	loopPanelExpanded = false;
}

function generateLoopId() {
	return `loop-${Math.random().toString(16).slice(2, 8)}-${Date.now().toString(16)}`;
}

function addAdvancedFlagRow(flag = "", value = "") {
	const container = elements.advancedOptionsContainer;
	if (!container) {
		return;
	}

	const row = document.createElement("div");
	row.className = "param-row advanced-row";

	const flagInput = document.createElement("input");
	flagInput.type = "text";
	flagInput.placeholder = "Flag (e.g., -H)";
	flagInput.value = sanitizeFlagNameInput(flag);
	flagInput.className = "advanced-flag-input";
	flagInput.addEventListener("input", () => {
		const cleaned = sanitizeFlagNameInput(flagInput.value);
		if (cleaned !== flagInput.value) {
			flagInput.value = cleaned;
		}
		sendReconstructCurlCommand();
	});
	flagInput.addEventListener("blur", () => {
		const cleaned = sanitizeFlagName(flagInput.value);
		if (cleaned !== flagInput.value) {
			flagInput.value = cleaned;
		}
		sendReconstructCurlCommand();
	});

	const valueInput = document.createElement("input");
	valueInput.type = "text";
	valueInput.placeholder = "Value (optional)";
	valueInput.value = sanitizeFlagValueInput(value);
	valueInput.className = "advanced-value-input";
	valueInput.addEventListener("input", () => {
		const cleaned = sanitizeFlagValueInput(valueInput.value);
		if (cleaned !== valueInput.value) {
			valueInput.value = cleaned;
		}
		sendReconstructCurlCommand();
	});
	valueInput.addEventListener("blur", () => {
		const cleaned = sanitizeFlagValue(valueInput.value);
		if (cleaned !== valueInput.value) {
			valueInput.value = cleaned;
		}
		sendReconstructCurlCommand();
	});

	const convertButton = document.createElement("button");
	convertButton.type = "button";
	convertButton.className = "convert-loop";
	convertButton.textContent = "→ Loop";
	convertButton.title = "Convert this flag into a loop to cycle header values.";
	convertButton.addEventListener("click", () => {
		const sanitizedFlag = sanitizeFlagName(flagInput.value);
		const sanitizedValue = sanitizeFlagValue(valueInput.value);
		if (!sanitizedFlag) {
			showGroupingMessage(
				"Provide a flag before converting to a loop.",
				"error",
			);
			return;
		}
		if (!isSupportedHeaderLoopFlag(sanitizedFlag)) {
			showGroupingMessage("Unsupported flag for header loops.", "error");
			return;
		}
		const normalizedFlag = normalizeLoopFlag("header", sanitizedFlag);
		if (!sanitizedValue) {
			showGroupingMessage(
				"Provide a value before converting to a loop.",
				"error",
			);
			return;
		}
		const requiresName = headerFlagRequiresName(normalizedFlag);
		const headerParts = extractHeaderParts(sanitizedValue, requiresName);
		if (!headerParts) {
			showGroupingMessage(
				requiresName
					? 'Header value must follow the "Name: Value" format.'
					: "Provide a value to loop.",
				"error",
			);
			return;
		}
		addLoop({
			targetType: "header",
			targetFlag: normalizedFlag,
			targetKey: headerParts.name,
			rawText: headerParts.value,
			values: headerParts.value ? [parseLoopValue(headerParts.value)] : [],
		});
		row.remove();
		sendReconstructCurlCommand();
		showGroupingMessage("");
	});

	const removeButton = document.createElement("button");
	removeButton.type = "button";
	removeButton.textContent = "×";
	removeButton.className = "remove-param";
	removeButton.addEventListener("click", () => {
		row.remove();
		sendReconstructCurlCommand();
	});

	row.appendChild(flagInput);
	row.appendChild(valueInput);
	row.appendChild(convertButton);
	row.appendChild(removeButton);
	container.appendChild(row);
}

function renderAdvancedFlags(flagStrings: unknown[]) {
	const container = elements.advancedOptionsContainer;
	if (!container) {
		return;
	}

	container.innerHTML = "";
	const flags = Array.isArray(flagStrings) ? flagStrings : [];
	if (!flags.length) {
		addAdvancedFlagRow();
		return;
	}

	flags.forEach((entry) => {
		const text = String(entry ?? "").trim();
		if (!text) {
			addAdvancedFlagRow();
			return;
		}
		const firstSpace = text.indexOf(" ");
		if (firstSpace === -1) {
			addAdvancedFlagRow(text, "");
		} else {
			const flag = text.slice(0, firstSpace);
			const value = text.slice(firstSpace + 1);
			addAdvancedFlagRow(flag, stripFlagQuotes(value));
		}
	});

	addAdvancedFlagRow();
}

function collectAdvancedFlags(): string[] {
	if (!elements.advancedOptionsContainer) {
		return [];
	}
	const results: string[] = [];
	elements.advancedOptionsContainer
		.querySelectorAll(".advanced-row")
		.forEach((row) => {
			const flagInput = row.querySelector(
				".advanced-flag-input",
			) as HTMLInputElement | null;
			const valueInput = row.querySelector(
				".advanced-value-input",
			) as HTMLInputElement | null;
			const rawFlag = flagInput ? sanitizeFlagNameInput(flagInput.value) : "";
			const flag = rawFlag.trim();
			const value = valueInput ? sanitizeFlagValue(valueInput.value) : "";
			if (flag.startsWith("-")) {
				results.push(value ? `${flag} ${formatFlagValue(value)}` : flag);
			}
		});
	return results;
}

function stripFlagQuotes(text: string): string {
	if (!text) {
		return "";
	}
	const trimmed = text.trim();
	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))
	) {
		return sanitizeFlagValueInput(trimmed.slice(1, -1));
	}
	return sanitizeFlagValueInput(trimmed);
}

function formatFlagValue(value: string): string {
	const sanitized = sanitizeFlagValue(value);
	if (!sanitized.length) {
		return '""';
	}
	if (sanitized.includes('"')) {
		return `'${sanitized}'`;
	}
	const escaped = escapeForDoubleQuotes(sanitized);
	return `"${escaped}"`;
}

function sanitizeFlagNameInput(value: string): string {
	if (typeof value !== "string") {
		return "";
	}
	return value
		.replace(/[\r\n]+/g, " ")
		.replace(/'+/g, "")
		.replace(/\s{2,}/g, " ");
}

function sanitizeFlagName(value: string): string {
	return sanitizeFlagNameInput(value).trim();
}

function sanitizeFlagValueInput(value: string): string {
	if (typeof value !== "string") {
		return "";
	}
	return value.replace(/[\r\n]+/g, " ").replace(/'+/g, "");
}

function sanitizeFlagValue(value: string): string {
	return sanitizeFlagValueInput(value).trim();
}

function escapeForDoubleQuotes(text: string): string {
	return text.replace(/(["\\$`])/g, "\\$1");
}

function getLoopTargetOptions(currentType: string | undefined) {
	return LOOP_TARGET_OPTIONS.filter((option) => {
		if (
			option.requiresAdvanced &&
			!advancedExpanded &&
			option.value !== currentType
		) {
			return false;
		}
		return true;
	});
}

function resolveLoopPlaceholder(
	type: string | undefined,
	flag?: string | null,
): string {
	if (type === "form") {
		return "Form field key";
	}
	if (type === "route") {
		return "Route key (scheme/subdomain/domain/port/path)";
	}
	if (type === "header") {
		return headerFlagRequiresName(flag)
			? "Header name"
			: "Value (looped directly)";
	}
	return "Query key";
}

function normalizeLoopTargetType(type: string | undefined): string {
	if (type === "form" || type === "header" || type === "route") {
		return type;
	}
	return "query";
}

function normalizeLoopFlag(
	targetType: string | undefined,
	flag: string | undefined | null,
): string | undefined {
	if (targetType !== "header") {
		return undefined;
	}
	const normalized = (flag || "").trim();
	if (!normalized) {
		return DEFAULT_HEADER_FLAG;
	}
	const match = HEADER_FLAG_OPTIONS.find(
		(option) => option.value.toLowerCase() === normalized.toLowerCase(),
	);
	return match ? match.value : DEFAULT_HEADER_FLAG;
}

function headerFlagRequiresName(flag: string | undefined | null): boolean {
	if (!flag) {
		return true;
	}
	const match = HEADER_FLAG_OPTIONS.find(
		(option) => option.value.toLowerCase() === flag.trim().toLowerCase(),
	);
	return match ? match.requiresName : true;
}

function isSupportedHeaderLoopFlag(flag: string): boolean {
	const normalized = flag.trim().toLowerCase();
	return HEADER_FLAG_OPTIONS.some(
		(option) => option.value.toLowerCase() === normalized,
	);
}

function extractHeaderParts(
	text: string,
	requiresName: boolean,
): { name: string; value: string } | null {
	const trimmed = text.trim();
	if (!trimmed.length) {
		return null;
	}
	if (!requiresName) {
		return { name: "", value: trimmed };
	}
	const separator = trimmed.indexOf(":");
	if (separator === -1) {
		return null;
	}
	const name = trimmed.slice(0, separator).trim();
	const value = trimmed.slice(separator + 1).trim();
	if (!name) {
		return null;
	}
	return { name, value };
}
