import React, { useState } from 'react';
import { Button } from './components';

export function usePagination(total) {
  const [pageSize, setSize] = useState(50), [requestedPage, setPage] = useState(1);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage, pageCount);
  if (requestedPage !== page) setPage(page);
  const start = (page - 1) * pageSize, end = Math.min(start + pageSize, total);
  return {page, pageSize, pageCount, start, end, setPage, setPageSize:size => { setSize(size); setPage(1); }};
}

export default function Pagination({ label, total, pagination, onPageChange, onPageSizeChange }) {
  const {page, pageSize, pageCount, start, end} = pagination;
  return <nav className="list-pagination" aria-label={`${label}分页`}>
    <span className="muted">共 {total} 条 · {total ? start + 1 : 0}–{end} 条</span>
    <label>每页<select aria-label={`${label}每页条数`} value={pageSize} onChange={event => onPageSizeChange(Number(event.target.value))}>{[30,50,100,200].map(size => <option key={size} value={size}>{size} 条</option>)}</select></label>
    <div className="pagination-pages"><Button secondary disabled={page === 1} onClick={() => onPageChange(page - 1)}>上一页</Button><span aria-live="polite">第 {page} / {pageCount} 页</span><Button secondary disabled={page === pageCount} onClick={() => onPageChange(page + 1)}>下一页</Button></div>
  </nav>;
}
