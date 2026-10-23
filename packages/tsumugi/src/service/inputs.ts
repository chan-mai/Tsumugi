export type CreateJobInput = {
	binding: string;
	payload: unknown;
	maxAttempts?: number;
	delayMs?: number;
	// 投入時刻からの相対期限, 経過後は未実行でCANCELLED
	expiresInMs?: number;
	priority?: number;
	concurrencyKey?: string;
	uniqueKey?: string;
	// 分割bindingの投入先shard決定用, shards>=2で必須(ADR-0011)
	partitionKey?: string;
	traceparent?: string;
};

export type StartRunInput = {
	flow: string;
	input: unknown;
	id?: string;
	// run全体の期限(ms), flow定義の期限より優先(ADR-0039)
	deadlineMs?: number;
};
