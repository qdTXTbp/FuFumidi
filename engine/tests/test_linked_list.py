# -*- coding: utf-8 -*-
"""linked_list.py 的纯逻辑测试：ListNode 构造与 merge_sorted_lists 的合并语义。

不测音频/模型能力，仅验证合并结果的升序性、相等值的稳定次序、
空链边界以及节点复用（不新建节点）。
"""

from linked_list import ListNode, merge_sorted_lists


def _build(*vals: int) -> ListNode | None:
    head: ListNode | None = None
    for v in reversed(vals):
        head = ListNode(v, head)
    return head


def _values(head: ListNode | None) -> list[int]:
    out: list[int] = []
    while head is not None:
        out.append(head.val)
        head = head.next
    return out


def _nodes(head: ListNode | None) -> list[ListNode]:
    out: list[ListNode] = []
    while head is not None:
        out.append(head)
        head = head.next
    return out


def test_list_node_default_construction():
    node = ListNode()
    assert node.val == 0
    assert node.next is None


def test_list_node_explicit_val_and_next():
    child = ListNode(2)
    node = ListNode(1, child)
    assert node.val == 1
    assert node.next is child


def test_merge_sorted_lists_both_empty_returns_none():
    assert merge_sorted_lists(None, None) is None


def test_merge_sorted_lists_left_empty_returns_right():
    right = _build(1, 2, 3)
    merged = merge_sorted_lists(None, right)
    assert merged is right
    assert _values(merged) == [1, 2, 3]


def test_merge_sorted_lists_right_empty_returns_left():
    left = _build(1, 2, 3)
    merged = merge_sorted_lists(left, None)
    assert merged is left
    assert _values(merged) == [1, 2, 3]


def test_merge_sorted_lists_single_nodes():
    left = _build(2)
    right = _build(1)
    merged = merge_sorted_lists(left, right)
    assert _values(merged) == [1, 2]


def test_merge_sorted_lists_interleaved_nodes_sorted():
    merged = merge_sorted_lists(_build(1, 3, 5), _build(2, 4, 6))
    assert _values(merged) == [1, 2, 3, 4, 5, 6]


def test_merge_sorted_lists_one_side_entirely_before_other():
    merged = merge_sorted_lists(_build(1, 2, 3), _build(4, 5))
    assert _values(merged) == [1, 2, 3, 4, 5]


def test_merge_sorted_lists_repeated_values_within_list_keep_order():
    merged = merge_sorted_lists(_build(1, 1, 2), _build(1, 1))
    assert _values(merged) == [1, 1, 1, 1, 2]


def test_merge_sorted_lists_equal_values_prefer_left_nodes():
    left_head = ListNode(1)
    left_tail = ListNode(3)
    left_head.next = left_tail
    right_head = ListNode(1)
    right_tail = ListNode(2)
    right_head.next = right_tail
    merged = merge_sorted_lists(left_head, right_head)
    assert _values(merged) == [1, 1, 2, 3]
    assert merged is left_head
    assert merged.next is right_head
    assert merged.next.next is right_tail
    assert merged.next.next.next is left_tail


def test_merge_sorted_lists_reuses_input_nodes_without_new():
    left = _build(1, 4)
    right = _build(2, 3)
    before = {id(n) for n in _nodes(left)} | {id(n) for n in _nodes(right)}
    merged = merge_sorted_lists(left, right)
    after = {id(n) for n in _nodes(merged)}
    assert after == before
    assert _values(merged) == [1, 2, 3, 4]
