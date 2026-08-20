/**
 * ジョブIDのアドレッシング(ADR-0005)
 * 形式は`<binding>#<shard>:<localId>`, IDからDO stubをO(1)で解決可能でグローバル索引が不要
 * 乱数を使うlocalIdの生成(cuid2)はここに置かない, coreは純粋に維持(ADR-0018)
 */

export type JobAddress = {
	binding: string;
	shard: number;
	localId: string;
};

/** env.NAME参照に使うbinding名はJS識別子に限定, #や:の混入防止も兼用 */
const BINDING_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** cuid2は英数字, 往復不能になる区切り文字の混入は拒否 */
const LOCAL_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export class InvalidJobIdError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'InvalidJobIdError';
	}
}

/**
 * ジョブIDを別IDのローカル部へ埋め込める形へ変換(#30)
 * 区切り文字は1対1の置換, bindingやshardが違えば結果も必ず別
 */
export function embedJobId(jobId: string): string {
	return jobId.replace(/_/g, '_0').replace(/#/g, '_1').replace(/:/g, '_2');
}

export function assertValidBinding(binding: string): void {
	if (!BINDING_PATTERN.test(binding)) {
		throw new InvalidJobIdError(`invalid binding name: ${JSON.stringify(binding)} (alphanumeric, must start with a letter or underscore)`);
	}
}

function assertValidShard(shard: number): void {
	if (!Number.isInteger(shard) || shard < 0) {
		throw new InvalidJobIdError(`invalid shard: ${shard} (non-negative integer)`);
	}
}

/** DOの名前, 既定のshard数1では`<binding>#0`へ集約(ADR-0011) */
export function shardName(binding: string, shard: number): string {
	assertValidBinding(binding);
	assertValidShard(shard);
	return `${binding}#${shard}`;
}

export function formatJobId(address: JobAddress): string {
	const { binding, shard, localId } = address;
	assertValidBinding(binding);
	assertValidShard(shard);
	if (!LOCAL_ID_PATTERN.test(localId)) {
		throw new InvalidJobIdError(`invalid localId: ${JSON.stringify(localId)}`);
	}
	return `${binding}#${shard}:${localId}`;
}

export function parseJobId(jobId: string): JobAddress {
	const hash = jobId.indexOf('#');
	if (hash < 0) throw new InvalidJobIdError(`missing "#": ${JSON.stringify(jobId)}`);
	const colon = jobId.indexOf(':', hash + 1);
	if (colon < 0) throw new InvalidJobIdError(`missing ":": ${JSON.stringify(jobId)}`);

	const binding = jobId.slice(0, hash);
	const shardText = jobId.slice(hash + 1, colon);
	const localId = jobId.slice(colon + 1);

	assertValidBinding(binding);
	if (!/^\d+$/.test(shardText)) throw new InvalidJobIdError(`shard is not a number: ${JSON.stringify(shardText)}`);
	const shard = Number(shardText);
	assertValidShard(shard);
	if (!LOCAL_ID_PATTERN.test(localId)) throw new InvalidJobIdError(`invalid localId: ${JSON.stringify(localId)}`);

	return { binding, shard, localId };
}

/** ジョブIDから所属するDOの名前を取得 */
export function shardNameOf(jobId: string): string {
	const { binding, shard } = parseJobId(jobId);
	return `${binding}#${shard}`;
}

/**
 * runIDのアドレッシング(ADR-0029)
 * 形式は`<flow>:<localId>`, そのままDOの名前でIDからRun DOをO(1)で解決可能
 */
export type RunAddress = { flow: string; localId: string };

/** flow名は`flows`のキーで区切り文字は不可, 文字種はノードIDと同一 */
const FLOW_PATTERN = /^[A-Za-z0-9_-]+$/;

export class InvalidRunIdError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'InvalidRunIdError';
	}
}

export function assertValidFlow(flow: string): void {
	if (!FLOW_PATTERN.test(flow)) {
		throw new InvalidRunIdError(`invalid flow name: ${JSON.stringify(flow)} (alphanumeric, hyphen and underscore only)`);
	}
}

export function formatRunId({ flow, localId }: RunAddress): string {
	if (!FLOW_PATTERN.test(flow))
		throw new InvalidRunIdError(`invalid flow name: ${JSON.stringify(flow)} (alphanumeric, hyphen and underscore only)`);
	if (!LOCAL_ID_PATTERN.test(localId)) throw new InvalidRunIdError(`invalid localId: ${JSON.stringify(localId)}`);
	return `${flow}:${localId}`;
}

export function parseRunId(runId: string): RunAddress {
	const colon = runId.indexOf(':');
	if (colon < 0) throw new InvalidRunIdError(`missing ":": ${JSON.stringify(runId)}`);
	const flow = runId.slice(0, colon);
	const localId = runId.slice(colon + 1);
	if (!FLOW_PATTERN.test(flow)) throw new InvalidRunIdError(`invalid flow name: ${JSON.stringify(flow)}`);
	if (!LOCAL_ID_PATTERN.test(localId)) throw new InvalidRunIdError(`invalid localId: ${JSON.stringify(localId)}`);
	return { flow, localId };
}
