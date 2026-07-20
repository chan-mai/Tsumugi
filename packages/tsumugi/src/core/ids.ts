/**
 * ジョブIDのアドレッシング(ADR-0005)
 * 形式は`<binding>#<shard>:<localId>`, IDからDO stubをO(1)で引けるのでグローバル索引が不要
 * localIdの生成(cuid2)は乱数を使うのでここには置かない, coreは純粋に保つ(ADR-0018)
 */

export type JobAddress = {
	binding: string;
	shard: number;
	localId: string;
};

/** binding名はenv.NAMEとして参照されるのでJS識別子に限る, #や:の混入を防ぐ担保も兼ねる */
const BINDING_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** cuid2は英数字,区切り文字の混入は往復不能になるので弾く */
const LOCAL_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export class InvalidJobIdError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'InvalidJobIdError';
	}
}

export function assertValidBinding(binding: string): void {
	if (!BINDING_PATTERN.test(binding)) {
		throw new InvalidJobIdError(`binding名が不正: ${JSON.stringify(binding)} (英字またはアンダースコア始まりの英数字のみ)`);
	}
}

function assertValidShard(shard: number): void {
	if (!Number.isInteger(shard) || shard < 0) {
		throw new InvalidJobIdError(`shardが不正: ${shard} (0以上の整数)`);
	}
}

/** DOの名前,既定はshard数1なので`<binding>#0`に集約(ADR-0011) */
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
		throw new InvalidJobIdError(`localIdが不正: ${JSON.stringify(localId)}`);
	}
	return `${binding}#${shard}:${localId}`;
}

export function parseJobId(jobId: string): JobAddress {
	const hash = jobId.indexOf('#');
	if (hash < 0) throw new InvalidJobIdError(`#がない: ${JSON.stringify(jobId)}`);
	const colon = jobId.indexOf(':', hash + 1);
	if (colon < 0) throw new InvalidJobIdError(`:がない: ${JSON.stringify(jobId)}`);

	const binding = jobId.slice(0, hash);
	const shardText = jobId.slice(hash + 1, colon);
	const localId = jobId.slice(colon + 1);

	assertValidBinding(binding);
	if (!/^\d+$/.test(shardText)) throw new InvalidJobIdError(`shardが数値でない: ${JSON.stringify(shardText)}`);
	const shard = Number(shardText);
	assertValidShard(shard);
	if (!LOCAL_ID_PATTERN.test(localId)) throw new InvalidJobIdError(`localIdが不正: ${JSON.stringify(localId)}`);

	return { binding, shard, localId };
}

/** ジョブIDから,それが住んでいるDOの名前を得る */
export function shardNameOf(jobId: string): string {
	const { binding, shard } = parseJobId(jobId);
	return `${binding}#${shard}`;
}
