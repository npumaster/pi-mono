/**
 * 具有推入时克隆（clone-on-push）语义的通用撤销栈。
 *
 * 存储状态快照的深拷贝。弹出的快照将直接返回（不再重新克隆），
 * 因为它们已经处于分离状态。
 */
export class UndoStack<S> {
	private stack: S[] = [];

	/** 将给定状态的深拷贝推入栈中。 */
	push(state: S): void {
		this.stack.push(structuredClone(state));
	}

	/** 弹出并返回最近的快照，如果为空则返回 undefined。 */
	pop(): S | undefined {
		return this.stack.pop();
	}

	/** 移除所有快照。 */
	clear(): void {
		this.stack.length = 0;
	}

	get length(): number {
		return this.stack.length;
	}
}
