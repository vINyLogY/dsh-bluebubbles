// Source-port: @deepseek-ai/dsh-llm-deepseek0.1.1-rc.2 (MIT), see ../NOTICE.
// Legacy Files API/cache/recovery logic; target SDK only, no old-core dependency.
import { LlmError, attributionHeaders } from '@deepseek-ai/dsh-llm';
import { ImageVariantId } from '@deepseek-ai/dsh-attachment';
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
function DeepSeekFileId(id) {
	return id;
}
/**
* Brand a locally derived namespace digest.
* @param scope - SHA-256 digest of endpoint and API key.
* @returns the same string with namespace identity attached at type level.
*/
function DeepSeekFileScope(scope) {
	return scope;
}
//#endregion
//#region lib/types/files-api.js
/** OpenAI-compatible DeepSeek Files API transport. @module dsh-llm-deepseek/files-api */
/** Minimum provider-supported file lifetime. */
const MIN_FILE_EXPIRY_SECONDS = 3600;
/** Maximum provider-supported file lifetime. */
const MAX_FILE_EXPIRY_SECONDS = 2592e3;
/** Maximum Files API upload size. */
const MAX_FILE_UPLOAD_BYTES = 128 * 1024 * 1024;
/** Current per-key file-count quota. */
const MAX_STORED_FILE_COUNT = 1e4;
/** Current per-key storage quota. */
const MAX_STORED_FILE_BYTES = 25 * 1024 * 1024 * 1024;
/** Files API operation failure with its HTTP status retained for recovery policy. */
var DeepSeekFilesError = class extends LlmError {
	/** Parsed provider detail used only for error classification. */
	detail;
	/**
	* @param message - user-readable provider failure.
	* @param status - HTTP status returned by the Files API.
	* @param detail - provider error fields joined for classification.
	*/
	constructor(message, status, detail) {
		super(message, status === 401 || status === 403 ? "AUTH" : status === 429 ? "RATE_LIMIT" : status >= 500 ? "SERVER" : "FILES_API", { status });
		this.name = "DeepSeekFilesError";
		this.detail = detail;
	}
};
/**
* Whether an upload failure reports a provider storage or file-count quota.
* @param error - Files API operation failure.
* @returns whether one bounded remote cleanup and upload retry may recover.
*/
function isFilesQuotaError(error) {
	return error instanceof DeepSeekFilesError && /(?:quota|storage|stored files|file count|too many files)/iu.test(error.detail);
}
function invalidResponse(operation) {
	return new LlmError(`DeepSeek Files API returned an invalid ${operation} response.`, "INVALID_RESPONSE");
}
function parseFileObject(value, operation) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalidResponse(operation);
	const wire = value;
	if (typeof wire.id !== "string" || wire.id.length === 0 || wire.object !== "file" || !Number.isSafeInteger(wire.bytes) || wire.bytes < 0 || !Number.isSafeInteger(wire.created_at) || wire.created_at < 0 || typeof wire.filename !== "string" || wire.filename.length === 0 || wire.purpose !== "user_data" || wire.expires_at !== void 0 && (!Number.isSafeInteger(wire.expires_at) || wire.expires_at < 0)) throw invalidResponse(operation);
	return {
		id: DeepSeekFileId(wire.id),
		bytes: wire.bytes,
		createdAt: wire.created_at,
		filename: wire.filename,
		purpose: "user_data",
		...wire.expires_at === void 0 ? {} : { expiresAt: wire.expires_at }
	};
}
function providerErrorDetail(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return { detail: "" };
	const error = value.error;
	if (error === null || typeof error !== "object" || Array.isArray(error)) return { detail: "" };
	const fields = error;
	const message = typeof fields.message === "string" ? fields.message : void 0;
	return {
		...message === void 0 ? {} : { message },
		detail: [
			fields.code,
			fields.type,
			fields.message
		].filter((field) => typeof field === "string").join(" ")
	};
}
/** Direct client for the OpenAI-compatible `/files` endpoints. */
var DeepSeekFilesClient = class {
	baseURL;
	apiKey;
	fetchImpl;
	/**
	* @param options - endpoint, API-key snapshot, and optional test transport.
	*/
	constructor(options) {
		this.baseURL = options.baseURL.replace(/\/+$/u, "");
		this.apiKey = options.apiKey;
		this.fetchImpl = options.fetch ?? globalThis.fetch;
	}
	async request(path, init, signal) {
		let response;
		try {
			const headers = new Headers(attributionHeaders());
			headers.set("authorization", `Bearer ${this.apiKey}`);
			response = await this.fetchImpl(`${this.baseURL}${path}`, {
				...init,
				headers,
				...signal === void 0 ? {} : { signal }
			});
		} catch (error) {
			if (signal?.aborted) throw error;
			throw new LlmError(`DeepSeek Files API request to ${this.baseURL} failed`, "TRANSPORT", { cause: error });
		}
		if (response.ok) return response;
		let parsed;
		try {
			parsed = await response.json();
		} catch {}
		const { message, detail } = providerErrorDetail(parsed);
		throw new DeepSeekFilesError(message ?? `DeepSeek Files API error (HTTP ${response.status})`, response.status, detail);
	}
	/**
	* Upload one image with an explicit expiry.
	* @param input - deterministic request-version bytes, media type, filename, lifetime, and cancellation.
	* @returns the validated provider file object, including `expires_at`.
	*/
	async upload(input) {
		if (input.data.byteLength > 134217728) throw new LlmError("DeepSeek Files API upload exceeds 128 MiB.", "INVALID_REQUEST");
		if (!Number.isSafeInteger(input.expiresAfterSeconds) || input.expiresAfterSeconds < 3600 || input.expiresAfterSeconds > 2592e3) throw new LlmError("DeepSeek file expiry must be between 3600 and 2592000 seconds.", "INVALID_REQUEST");
		const form = new FormData();
		form.set("purpose", "user_data");
		form.set("expires_after[anchor]", "created_at");
		form.set("expires_after[seconds]", String(input.expiresAfterSeconds));
		form.set("file", new Blob([Uint8Array.from(input.data).buffer], { type: input.mediaType }), input.filename);
		const file = parseFileObject(await (await this.request("/files", {
			method: "POST",
			body: form
		}, input.signal)).json(), "upload");
		if (file.expiresAt === void 0) throw invalidResponse("upload");
		return {
			...file,
			expiresAt: file.expiresAt
		};
	}
	/**
	* List one ascending or descending page of user-data files.
	* @param options - pagination, ordering, and cancellation.
	* @returns the validated page.
	*/
	async list(options = {}) {
		const query = new URLSearchParams({ purpose: "user_data" });
		if (options.after !== void 0) query.set("after", options.after);
		if (options.limit !== void 0) query.set("limit", String(options.limit));
		if (options.order !== void 0) query.set("order", options.order);
		const value = await (await this.request(`/files?${query.toString()}`, { method: "GET" }, options.signal)).json();
		if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalidResponse("list");
		const wire = value;
		if (wire.object !== "list" || !Array.isArray(wire.data) || typeof wire.has_more !== "boolean" || wire.first_id !== void 0 && typeof wire.first_id !== "string" || wire.last_id !== void 0 && typeof wire.last_id !== "string") throw invalidResponse("list");
		return {
			data: wire.data.map((item) => parseFileObject(item, "list")),
			...typeof wire.first_id === "string" ? { firstId: DeepSeekFileId(wire.first_id) } : {},
			...typeof wire.last_id === "string" ? { lastId: DeepSeekFileId(wire.last_id) } : {},
			hasMore: wire.has_more
		};
	}
	/**
	* Retrieve one file object.
	* @param fileId - provider file identifier.
	* @param signal - request cancellation.
	* @returns the validated file object.
	*/
	async retrieve(fileId, signal) {
		return parseFileObject(await (await this.request(`/files/${encodeURIComponent(fileId)}`, { method: "GET" }, signal)).json(), "retrieve");
	}
	/**
	* Delete one provider file.
	* @param fileId - provider file identifier.
	* @param signal - request cancellation.
	*/
	async delete(fileId, signal) {
		const value = await (await this.request(`/files/${encodeURIComponent(fileId)}`, { method: "DELETE" }, signal)).json();
		if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalidResponse("delete");
		const wire = value;
		if (wire.id !== fileId || wire.object !== "file" || wire.deleted !== true) throw invalidResponse("delete");
	}
};
//#endregion
//#region lib/types/upload-index.js
/** Durable DeepSeek attachment-to-file-id index. @module dsh-llm-deepseek/upload-index */
var InvalidUploadIndexError = class extends Error {};
/**
* Derive a non-secret stable index namespace without persisting or logging the API key.
* @param baseURL - normalized provider endpoint namespace.
* @param apiKey - resolved credential used only as hash input.
* @returns branded SHA-256 namespace digest.
*/
function deepSeekFileScope(baseURL, apiKey) {
	return DeepSeekFileScope(createHash("sha256").update(baseURL.replace(/\/+$/u, "")).update("\0").update(apiKey).digest("hex"));
}
function absent(error) {
	return error?.code === "ENOENT";
}
function parseRecord(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new InvalidUploadIndexError("llm-deepseek: upload index contains a non-object record");
	const record = value;
	if (typeof record.scope !== "string" || !/^[0-9a-f]{64}$/u.test(record.scope) || typeof record.attachmentId !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(record.attachmentId) || typeof record.variantId !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(record.variantId) || typeof record.fileId !== "string" || record.fileId.length === 0 || !Number.isSafeInteger(record.bytes) || record.bytes < 0 || !Number.isSafeInteger(record.createdAt) || record.createdAt < 0 || !Number.isSafeInteger(record.expiresAt) || record.expiresAt < 0) throw new InvalidUploadIndexError("llm-deepseek: upload index contains an invalid record");
	return {
		scope: DeepSeekFileScope(record.scope),
		attachmentId: record.attachmentId,
		variantId: ImageVariantId(record.variantId),
		fileId: DeepSeekFileId(record.fileId),
		bytes: record.bytes,
		createdAt: record.createdAt,
		expiresAt: record.expiresAt
	};
}
function parseIndex(text) {
	let value;
	try {
		value = JSON.parse(text);
	} catch (error) {
		throw new InvalidUploadIndexError("llm-deepseek: upload index is not valid JSON", { cause: error });
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new InvalidUploadIndexError("llm-deepseek: upload index is not an object");
	const index = value;
	if (index.formatVersion !== 3 || !Array.isArray(index.records)) throw new InvalidUploadIndexError("llm-deepseek: unsupported upload index format");
	const records = index.records.map(parseRecord);
	const keys = /* @__PURE__ */ new Set();
	for (const record of records) {
		const key = `${record.scope}\0${record.variantId}`;
		if (keys.has(key)) throw new InvalidUploadIndexError("llm-deepseek: upload index contains duplicate mappings");
		keys.add(key);
	}
	return {
		formatVersion: 3,
		records
	};
}
function reusable(record, now, refreshMarginMs) {
	return record.expiresAt - now > refreshMarginMs;
}
/** Atomic local index shared by every DeepSeek session in this DSH home. */
var DeepSeekUploadIndex = class {
	/** Absolute owner-private JSON index path. */
	path;
	/**
	* @param path - explicit test path; omission uses `DSH_HOME/llm-deepseek/files-v3.json`.
	*/
	constructor(path = join(resolveDshHome(), "legacy-011-chat-completions", "files-v3.json")) {
		this.path = path;
	}
	async load() {
		try {
			return parseIndex(await readFile(this.path, "utf8"));
		} catch (error) {
			if (absent(error) || error instanceof InvalidUploadIndexError) return {
				formatVersion: 3,
				records: []
			};
			throw error;
		}
	}
	async save(index) {
		await writeFileAtomic(this.path, `${JSON.stringify(index, void 0, 2)}\n`, {
			mode: 384,
			dirMode: 448
		});
	}
	/**
	* Read one reusable mapping.
	* @param scope - endpoint/API-key namespace.
	* @param variantId - complete request-image transformation identity.
	* @param now - current Unix time in milliseconds.
	* @param refreshMarginMs - remaining lifetime below which a mapping is not reused.
	* @returns the mapping when it has enough lifetime remaining.
	*/
	async get(scope, variantId, now, refreshMarginMs) {
		const record = (await this.load()).records.find((candidate) => candidate.scope === scope && candidate.variantId === variantId);
		return record !== void 0 && reusable(record, now, refreshMarginMs) ? record : void 0;
	}
	/**
	* Publish a completed upload unless another process already published a reusable mapping.
	* @param candidate - completed remote upload.
	* @param now - current Unix time in milliseconds.
	* @param refreshMarginMs - minimum reusable remaining lifetime.
	* @returns the winning record and whether the candidate entered the index.
	*/
	async commit(candidate, now, refreshMarginMs) {
		await mkdir(dirname(this.path), {
			recursive: true,
			mode: 448
		});
		return withFileLock(this.path, async () => {
			const index = await this.load();
			const existing = index.records.find((record) => record.scope === candidate.scope && record.variantId === candidate.variantId && reusable(record, now, refreshMarginMs));
			if (existing !== void 0) return {
				record: existing,
				accepted: false
			};
			const records = index.records.filter((record) => reusable(record, now, refreshMarginMs) && !(record.scope === candidate.scope && record.variantId === candidate.variantId));
			records.push(candidate);
			await this.save({
				formatVersion: 3,
				records
			});
			return {
				record: candidate,
				accepted: true
			};
		});
	}
	/**
	* Remove one exact mapping without deleting a concurrently installed successor.
	* @param scope - endpoint/API-key namespace.
	* @param variantId - complete request-image transformation identity.
	* @param fileId - exact remote generation being invalidated.
	*/
	async remove(scope, variantId, fileId) {
		await mkdir(dirname(this.path), {
			recursive: true,
			mode: 448
		});
		await withFileLock(this.path, async () => {
			const index = await this.load();
			const records = index.records.filter((record) => !(record.scope === scope && record.variantId === variantId && record.fileId === fileId));
			if (records.length !== index.records.length) await this.save({
				formatVersion: 3,
				records
			});
		});
	}
	/**
	* Remove every local mapping for one remote namespace.
	* @param scope - endpoint/API-key namespace.
	*/
	async clear(scope) {
		await mkdir(dirname(this.path), {
			recursive: true,
			mode: 448
		});
		await withFileLock(this.path, async () => {
			const index = await this.load();
			const records = index.records.filter((record) => record.scope !== scope);
			if (records.length !== index.records.length) await this.save({
				formatVersion: 3,
				records
			});
		});
	}
};
//#endregion
//#region lib/types/file-store.js
/** DeepSeek Files API upload reuse, invalidation, and quota recovery. @module dsh-llm-deepseek/file-store */
/** DeepSeek chat accepts at most 32 MiB per image even when it is referenced by file id. */
const MAX_CHAT_IMAGE_BYTES = 32 * 1024 * 1024;
const OWNED_FILE_PREFIX = "dsh-";
function abortReason(signal) {
	const reason = signal.reason;
	return reason instanceof Error ? reason : new Error("DeepSeek file upload cancelled with a non-Error reason.", { cause: reason });
}
function uploadFailure(error) {
	return error instanceof Error ? error : new Error("DeepSeek file upload failed with a non-Error reason.", { cause: error });
}
function waitForUpload(operation, signal) {
	signal?.throwIfAborted();
	operation.waiters += 1;
	let released = false;
	const release = (cancelledReason) => {
		if (released) return;
		released = true;
		operation.waiters -= 1;
		if (cancelledReason !== void 0 && operation.waiters === 0 && !operation.settled) operation.controller.abort(cancelledReason);
	};
	if (signal === void 0) return operation.promise.finally(() => {
		release();
	});
	return new Promise((resolve, reject) => {
		const abort = () => {
			const reason = abortReason(signal);
			release(reason);
			reject(reason);
		};
		signal.addEventListener("abort", abort, { once: true });
		operation.promise.then((value) => {
			signal.removeEventListener("abort", abort);
			release();
			resolve(value);
		}, (error) => {
			signal.removeEventListener("abort", abort);
			release();
			reject(uploadFailure(error));
		});
	});
}
function extension(mediaType) {
	switch (mediaType) {
		case "image/png": return "png";
		case "image/jpeg": return "jpeg";
		case "image/webp": return "webp";
		case "image/gif": return "gif";
	}
}
function filename(version) {
	return `${OWNED_FILE_PREFIX}${String(version.attachment.attachmentId).slice(7, 23)}-${String(version.variantId).slice(7, 15)}.${extension(version.mediaType)}`;
}
/** User-scoped durable file-id reuse for the DeepSeek route. */
var DeepSeekFileStore = class {
	index;
	now;
	fetchImpl;
	inflight = /* @__PURE__ */ new Map();
	/**
	* @param options - testable index, clock, and transport boundaries.
	*/
	constructor(options = {}) {
		this.index = options.index ?? new DeepSeekUploadIndex();
		this.now = options.now ?? Date.now;
		this.fetchImpl = options.fetch;
	}
	client(connection) {
		return new DeepSeekFilesClient({
			baseURL: connection.baseURL,
			apiKey: connection.apiKey,
			...this.fetchImpl === void 0 ? {} : { fetch: this.fetchImpl }
		});
	}
	/**
	* Resolve or upload one deterministic request image. Concurrent calls share one upload while retaining independent waits.
	* @param version - deterministic model-request bytes and complete transformation identity.
	* @param connection - endpoint and API-key snapshot.
	* @param policy - expiry and quota-recovery policy.
	* @param signal - cancellation of this wait; shared transport stops when no waiter remains.
	* @returns a reusable file id and whether this call published a new upload.
	*/
	ensureUploaded(version, connection, policy, signal) {
		signal?.throwIfAborted();
		const key = `${deepSeekFileScope(connection.baseURL, connection.apiKey)}\0${version.variantId}`;
		let active = this.inflight.get(key);
		if (active?.controller.signal.aborted) {
			this.inflight.delete(key);
			active = void 0;
		}
		if (active !== void 0) return waitForUpload(active, signal);
		const controller = new AbortController();
		const shared = {
			controller,
			settled: false,
			waiters: 0,
			promise: void 0
		};
		shared.promise = this.ensureUploadedOnce(version, connection, policy, controller.signal).then((value) => {
			shared.settled = true;
			return value;
		}, (error) => {
			shared.settled = true;
			throw uploadFailure(error);
		});
		this.inflight.set(key, shared);
		shared.promise.finally(() => {
			if (this.inflight.get(key) === shared) this.inflight.delete(key);
		}).catch(() => {});
		return waitForUpload(shared, signal);
	}
	async ensureUploadedOnce(version, connection, policy, signal) {
		if (version.bytes > 33554432) throw new LlmError("DeepSeek chat image exceeds the 32 MiB per-image limit.", "INVALID_REQUEST");
		const scope = deepSeekFileScope(connection.baseURL, connection.apiKey);
		const now = this.now();
		const marginMs = policy.refreshMarginSeconds * 1e3;
		const cached = await this.index.get(scope, version.variantId, now, marginMs);
		if (cached !== void 0) return {
			record: cached,
			uploaded: false
		};
		const client = this.client(connection);
		const upload = async () => {
			const remote = await client.upload({
				data: version.data,
				mediaType: version.mediaType,
				filename: filename(version),
				expiresAfterSeconds: policy.expiresAfterSeconds,
				signal
			});
			if (remote.bytes !== version.data.byteLength) throw new LlmError("DeepSeek Files API upload response does not match the submitted image.", "INVALID_RESPONSE");
			return {
				scope,
				attachmentId: version.attachment.attachmentId,
				variantId: version.variantId,
				fileId: remote.id,
				bytes: remote.bytes,
				createdAt: remote.createdAt * 1e3,
				expiresAt: remote.expiresAt * 1e3
			};
		};
		// Unlike the legacy plugin, never infer remote ownership from a dsh-
		// filename prefix. Quota failure falls back to inline or remains an error.
		const candidate = await upload();
		const committed = await this.index.commit(candidate, this.now(), marginMs);
		if (!committed.accepted) try {
			await client.delete(candidate.fileId, signal);
		} catch {}
		return {
			record: committed.record,
			uploaded: committed.accepted
		};
	}
	/**
	* Invalidate one exact local mapping after the chat endpoint rejects its remote id.
	* @param version - request-image version whose remote generation failed.
	* @param fileId - exact rejected file id.
	* @param connection - endpoint and API-key snapshot.
	*/
	async invalidate(version, fileId, connection) {
		await this.index.remove(deepSeekFileScope(connection.baseURL, connection.apiKey), version.variantId, fileId);
	}
};
export { DeepSeekFilesClient, DeepSeekFileStore, DeepSeekUploadIndex };
