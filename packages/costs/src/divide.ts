// The division of a shared cost between the accounts (docs/ARCHITECTURE.md, section 7.6, requirement S4).
// The parts follow the usage and are whole numbers. The sum of the parts is the amount.

export interface Usage {
	accountId: string;
	// The number of cost rows of the account in the period that are not divided.
	usage: number;
}

export interface Part extends Usage {
	amount: number;
}

// The remainder goes to the accounts with the largest fractions, then in the sequence of the account ids.
// With no usage, the parts are equal. The parts come in the sequence of the account ids.
export function divide(amount: number, usages: readonly Usage[]): Part[] {
	const sorted = [...usages].sort((a, b) => (a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0));
	const all = sorted.reduce((sum, item) => sum + item.usage, 0);
	// With no usage, each account has the weight 1.
	const weight = (item: Usage) => (all === 0 ? 1 : item.usage);
	const weights = sorted.reduce((sum, item) => sum + weight(item), 0);
	if (weights === 0) return [];
	// Each exact part is amount * weight / weights. Whole numbers keep the calculation exact.
	const parts = sorted.map((item, index) => {
		const exact = amount * weight(item);
		return { ...item, amount: Math.floor(exact / weights), fraction: exact % weights, index };
	});
	let remainder = amount - parts.reduce((sum, part) => sum + part.amount, 0);
	const byFraction = [...parts].sort((a, b) => b.fraction - a.fraction || a.index - b.index);
	for (const part of byFraction) {
		if (remainder === 0) break;
		part.amount += 1;
		remainder -= 1;
	}
	return parts.map(({ accountId, usage, amount: share }) => ({ accountId, usage, amount: share }));
}
