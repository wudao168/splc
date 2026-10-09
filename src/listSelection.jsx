import React, { useState } from 'react';

/** 列表行选择：支持单选、多选与当前页全选；翻页或筛选后按当前行重新计算。 */
export function useRowSelection(rows, keyOf = row => row.id) {
  const [selected, setSelected] = useState([]);
  const keys = rows.map(keyOf);
  const picked = rows.filter(row => selected.includes(keyOf(row)));
  const allSelected = keys.length > 0 && picked.length === keys.length;
  const isSelected = row => selected.includes(keyOf(row));
  const toggleRow = row => setSelected(current => {
    const key = keyOf(row);
    return current.includes(key) ? current.filter(value => value !== key) : [...current, key];
  });
  const toggleAll = () => setSelected(current => allSelected
    ? current.filter(key => !keys.includes(key))
    : [...new Set([...current, ...keys])]);
  const clear = () => setSelected([]);
  return { picked, count: picked.length, single: picked.length === 1 ? picked[0] : null, allSelected, isSelected, toggleRow, toggleAll, clear };
}

export function SelectAllBox({ selection, disabled, label = '全选当前页' }) {
  return <input type="checkbox" aria-label={label} checked={selection.allSelected} disabled={disabled} onChange={selection.toggleAll}/>;
}

export function SelectBox({ selection, row, label, disabled }) {
  return <input type="checkbox" aria-label={label} checked={selection.isSelected(row)} disabled={disabled} onChange={() => selection.toggleRow(row)}/>;
}
