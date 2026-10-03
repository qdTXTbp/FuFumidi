# -*- coding: utf-8 -*-
"""有序链表合并。"""

from __future__ import annotations

__all__ = ["ListNode", "merge_sorted_lists"]


class ListNode:
    """单链表节点。"""

    __slots__ = ("val", "next")

    def __init__(self, val: int = 0, next: ListNode | None = None) -> None:
        self.val = val
        self.next = next


def merge_sorted_lists(l1: ListNode | None, l2: ListNode | None) -> ListNode | None:
    """把两个升序链表合并为一个升序链表，返回合并后的头节点。

    直接重链原有节点、不新建节点，两条输入链表会被消费（不再各自成链）。
    两值相等时先取 l1 的节点，保证稳定合并。
    """
    dummy = ListNode()
    tail = dummy
    while l1 is not None and l2 is not None:
        if l1.val <= l2.val:
            tail.next = l1
            l1 = l1.next
        else:
            tail.next = l2
            l2 = l2.next
        tail = tail.next
    tail.next = l1 if l1 is not None else l2
    return dummy.next
