import React, { useEffect, useRef, useState } from 'react';
import { Plus, Trash2, FileText, ExternalLink, ChevronDown } from 'lucide-react';
import { api, filePayload, money, q } from './api';
import { Button, Panel, Field, InputField, Table, SaveBar, Modal, SearchSelect } from './components';
import { CustomerEditor } from './Customers';
import { matchItem } from './StockLookup';
import ItemSuggest from './ItemSuggest';
import { ColumnSettings, useColumnSettings } from './columnSettings';

const FIELDS = [['name','料品名称'],['spec','料品规格'],['brand','品牌'],['description','料品描述'],['quantity','数量'],['unit','单位'],['price','单价（含税）'],['customer_code','客户料号'],['project_code','项目号'],['subproject_code','子项目号'],['remark','备注']];
const blank = () => ({ name: '', spec: '', brand: '', description: '', quantity: '', unit: '个', customer_code: '', project_code: '', subproject_code: '', remark: '', price: 0 });
/** 料品明细的列设置项，顺序与表格列一致（删除按钮固定显示）。 */
const IMPORT_COLUMNS = [['name','料品名称'],['spec','料品规格'],['brand','品牌'],['description','料品描述'],['quantity','数量'],['stock','现存量'],['available','可用库存'],['unit','单位'],['net_price','单价'],['tax_rate','税率'],['price','单价（含税）'],['subtotal','小计（含税）'],['customer_code','客户料号'],['project_code','项目号'],['subproject_code','子项目号'],['remark','备注']];
/** 料品明细各列的相对宽度（与表头一一对应，最后一个是删除列）；隐藏列后按可见列重新归一化。 */
const IMPORT_HEADER_KEYS = ['name','spec','brand','description','quantity','stock','available','unit','net_price','tax_rate','price','subtotal','customer_code','project_code','subproject_code','remark',''];
const IMPORT_WEIGHTS = [10, 9, 5, 10, 5, 5, 5, 4, 6, 5, 6, 7, 6, 5, 5, 10, 4];
const MAX_IMPORT_MB = 100;
const lineTotalCents = line => Math.round(Number(line.quantity || 0) * Math.round(Number(line.price || 0) * 100));

export default function ImportPage({ run, busy, navigate, data, editing, draftToResume, user }) {
  const { hidden: hiddenColumns, toggle: toggleColumn, reset: resetColumns, attr: hiddenColumnsAttr } = useColumnSettings(user, 'import_lines');
  const fileInput = useRef(null);
  const draft = draftToResume?.payload;
  const [source, setSource] = useState(draft?.source || (editing?.source_id ? { source_id: editing.source_id, filename: '原始客户文件' } : null)), [selected, setSelected] = useState(draft?.selected || 0), [mapping, setMapping] = useState(draft?.mapping || {}), [selectedFile, setSelectedFile] = useState(draft?.source?.filename || '');
  const [form, setForm] = useState(draft?.form || editing || { customer_id: '', customer: '', po: '', contact: '', phone: '', address: '', due_date: '', note: '', salesperson_id: '' });
  const [addressOpen, setAddressOpen] = useState(false), [addressEditing, setAddressEditing] = useState(false);
  const [customerEditor, setCustomerEditor] = useState(false), [selectedPo, setSelectedPo] = useState(draft?.selectedPo || ''), [intakeDraftId, setIntakeDraftId] = useState(draftToResume?.id || null), [appliedSheets, setAppliedSheets] = useState(draft?.appliedSheets || []), [draftToDelete, setDraftToDelete] = useState(null);
  const [autoPo, setAutoPo] = useState(!!draft?.autoPo);
  const poBeforeAuto = useRef('');
  const companyCode = (data.company?.company_code || '').trim();
  const customers = data.customers || [];
  const salespeople = (data.users || []).filter(u => u.active || u.id === Number(form.salesperson_id));
  const customer = customers.find(x => x.id === Number(form.customer_id));
  const contacts = [...(customer?.contacts || []), ...(customer?.addresses || []).filter(a => a.contact || a.phone).map(a => ({ name: a.contact || '', phone: a.phone || '' }))]
    .filter((c, i, all) => all.findIndex(x => x.name === c.name && x.phone === c.phone) === i);
  const contactIndex = contacts.findIndex(x => x.name === form.contact && x.phone === form.phone);
  const addressIndex = customer?.addresses.findIndex(a => a.address === form.address && ((!a.contact && !a.phone) || (a.contact === form.contact && a.phone === form.phone))) ?? -1;
  const chooseCustomer = c => {
    const contact = c?.contacts.length === 1 ? c.contacts[0] : null;
    const address = c?.addresses.length === 1 ? c.addresses[0] : null;
    const hasRecipient = address?.contact || address?.phone;
    setForm(f => ({ ...f, customer_id: c?.id || '', customer: c?.name || '', contact: hasRecipient ? address.contact || '' : contact?.name || '', phone: hasRecipient ? address.phone || '' : contact?.phone || '', address: address?.address || '' }));
    setAddressOpen(false);
    setAddressEditing(false);
    setChecked(false);
  };
  const chooseAddress = index => {
    const a = customer.addresses[index];
    const fallback = customer.contacts.length === 1 ? customer.contacts[0] : null;
    setForm(f => ({ ...f, address: a?.address || '', ...(a ? { contact: a.contact || a.phone ? a.contact || '' : fallback?.name || '', phone: a.contact || a.phone ? a.phone || '' : fallback?.phone || '' } : {}) }));
    setAddressOpen(false);
    setAddressEditing(false);
    setChecked(false);
  };
  const [lines, setLines] = useState(() => draft?.lines || (editing ? data.order_lines.filter(l => l.order_id === editing.id).map(l => ({ ...l, price: l.price_cents / 100 })) : [blank()])), [paste, setPaste] = useState(draft?.paste || ''), [checked, setChecked] = useState(false);
  const patch = (key, value) => { setForm(f => ({ ...f, [key]: value })); setChecked(false); };
  async function toggleAutoPo(enabled) {
    if (!enabled) { setAutoPo(false); patch('po', poBeforeAuto.current); return; }
    if (!companyCode) { run(async () => { throw new Error('请先在“设置 · 公司信息”中填写公司代码（一般为 2 个字母）'); }); return; }
    await run(async () => {
      const result = await api('/orders/next-po', {});
      setForm(f => ({ ...f, po: result.po }));
      setChecked(false);
      setAutoPo(true);
    }, `已按规则生成内部 PO 号（PO + ${companyCode} + 日期 + 流水号）`);
  }
  useEffect(() => {
    if (!autoPo) return;
    let cancelled = false;
    api('/orders/next-po', {}).then(result => { if (!cancelled) setForm(f => (f.po === result.po ? f : { ...f, po: result.po })); }).catch(() => {});
    return () => { cancelled = true; };
  }, [autoPo]);
  const changeLine = (i, key, value) => { setLines(xs => xs.map((x, j) => j === i ? { ...x, [key]: value, ...(key === 'net_price' ? {price: value === '' ? '' : (Number(value) * (1 + (x.tax_rate ?? data.tax_settings?.default_rate ?? 13) / 100)).toFixed(2)} : key === 'price' || key === 'tax_rate' ? {net_price: undefined} : {}) } : x)); setChecked(false); };
  const pickItem = (i, item) => { setLines(xs => xs.map((x, j) => j === i ? { ...x, name: item.name, spec: item.spec || '', brand: item.brand || '', unit: item.unit || x.unit || '个', customer_code: x.customer_code || item.customer_code || '' } : x)); setChecked(false); };
  const applyTable = (table, map, po = '', mode = 'replace') => {
    if (!table) return;
    const rows = po && table.po_column !== undefined ? table.rows.filter(r => r.values[table.po_column] === po) : table.rows;
    const incoming = rows.map(r => Object.fromEntries(FIELDS.map(([key]) => { const value = map[key] === undefined ? '' : (r.values[map[key]] ?? ''); return [key, key === 'unit' ? (String(value).trim() || '个') : key === 'price' ? (value || 0) : value]; })));
    setLines(current => mode === 'append' ? [...current.filter(line => ['name', 'spec', 'brand', 'description', 'quantity', 'customer_code'].some(key => String(line[key] ?? '').trim())), ...incoming] : incoming);
    setChecked(false);
  };
  const sheetKey = `${selected}:${selectedPo}`;
  const selectedTable = source?.tables?.[selected];
  const needsPo = selectedTable?.po_candidates?.length > 1;
  function applySelected(mode) {
    if (!selectedTable || (needsPo && !selectedPo) || (mode === 'append' && appliedSheets.includes(sheetKey))) return;
    const po = selectedPo || selectedTable.metadata?.po || '';
    if (mode === 'append' && po && form.po && po !== form.po) {
      run(async () => { throw new Error(`当前工作表的 PO（${po}）与订单 PO（${form.po}）不同，请核对后再追加。`); });
      return;
    }
    applyTable(selectedTable, mapping, selectedPo, mode);
    setAppliedSheets(mode === 'append' ? [...appliedSheets, sheetKey] : [sheetKey]);
    if (po && !autoPo && (mode === 'replace' || !form.po)) patch('po', po);
  }
  async function readFile(e) {
    const file = e.target.files?.[0]; if (!file) return;
    e.target.value = "";
    await run(async () => {
      const result = await api('/imports', await filePayload(file, MAX_IMPORT_MB));
      setSelectedFile(file.name); setSource(result); setSelected(0); setSelectedPo('');
      const table = result.tables[0];
      const meta = { ...result.metadata, ...table?.metadata };
      const matched = customers.find(c => c.name === meta.customer);
      if (meta.customer) chooseCustomer(matched);
      setForm(f => ({ ...f, po: autoPo ? f.po : (meta.po || ''), due_date: meta.due_date || f.due_date }));
      const map = table?.mapping || {}; setMapping(map);
      if (table?.po_candidates?.length > 1) { setLines([blank()]); setAppliedSheets([]); }
      else { applyTable(table, map); setAppliedSheets(table ? ['0:'] : []); }
    }, '文件已读取，请核对识别结果');
  }
  async function readPaste() {
    await run(async () => {
      const result = await api('/parse-text', { text: paste, kind: 'items' });
      setSource(s => ({ ...s, tables: result.tables, warnings: ['粘贴内容已转换，请核对全部料品。'] }));
      setSelected(0); setSelectedPo(''); setMapping(result.tables[0].mapping); applyTable(result.tables[0], result.tables[0].mapping); setAppliedSheets(['0:']);
    });
  }
  async function saveDraft() {
    await run(async () => {
      const payload = { form, lines, source, selected, mapping, selectedPo, appliedSheets, paste, autoPo };
      const result = await api(intakeDraftId ? `/intake-drafts/${intakeDraftId}` : '/intake-drafts', { payload });
      setIntakeDraftId(result.id);
    }, '未完成草稿已暂存，可从左侧继续填写');
  }
  function resumeDraft(draft) {
    const p = draft.payload;
    setForm(p.form); setLines(p.lines); setSource(p.source);
    setSelected(p.selected || 0); setMapping(p.mapping || {});
    setSelectedPo(p.selectedPo || ''); setAppliedSheets(p.appliedSheets || []); setPaste(p.paste || '');
    setSelectedFile(p.source?.filename || ''); setIntakeDraftId(draft.id); setChecked(false); setAutoPo(!!p.autoPo);
  }
  async function deleteDraft(draft) {
    await run(async () => {
      await api(`/intake-drafts/${draft.id}/delete`, {});
      if (intakeDraftId === draft.id) {
        setForm({ customer_id: '', customer: '', po: '', contact: '', phone: '', address: '', due_date: '', note: '', salesperson_id: '' });
        setLines([blank()]); setSource(null); setSelectedFile(''); setSelected(0); setSelectedPo(''); setMapping({}); setAppliedSheets([]);
        setPaste(''); setChecked(false); setIntakeDraftId(null); setAutoPo(false); poBeforeAuto.current = '';
      }
      setDraftToDelete(null);
    }, '草稿已删除');
  }
  async function save(e) {
    e.preventDefault();
    await run(async () => {
      // 已确认订单不能直接改写：先新建报价版本（第 N+1 版草稿），保存后再确认，历史版本仍保留在报价历史中。
      const revise = !!editing && editing.status === 'confirmed';
      if (revise) await api(`/orders/${editing.id}/revise`, {});
      try {
        await api(editing ? `/orders/${editing.id}/edit` : '/orders', { ...form, source_id: source?.source_id, intake_draft_id: intakeDraftId, lines, auto_po: autoPo });
      } catch (error) {
        // 保存失败时把刚新建的版本重新确认回原状态，避免订单停在未确认草稿上。
        if (revise) await api(`/orders/${editing.id}/confirm`, {}).catch(() => {});
        throw error;
      }
      if (revise) await api(`/orders/${editing.id}/confirm`, {});
      navigate('orders');
      if (!editing) {
        setForm({ customer_id: '', customer: '', po: '', contact: '', phone: '', address: '', due_date: '', note: '', salesperson_id: '' });
        setLines([blank()]); setSource(null); setSelectedFile(''); setSelected(0); setSelectedPo(''); setMapping({}); setAppliedSheets([]); setChecked(false); setIntakeDraftId(null); setAutoPo(false); poBeforeAuto.current = '';
      }
    }, editing ? (editing.status === 'confirmed' ? `已保存为第 ${editing.version + 1} 版并保持已确认` : '订单修改已保存') : '客户订单已保存为报价草稿');
  }
  const quoteTotalCents = lines.reduce((sum, line) => sum + lineTotalCents(line), 0);
  const quantityTotal = lines.reduce((sum, line) => sum + Number(line.quantity || 0), 0);
  const stockRows = lines.map(line => matchItem(data.items || [], line, data.item_aliases || []));
  return <><div className="import-layout"><div className="import-source"><Panel title="原始客户文件"><input ref={fileInput} hidden aria-label="上传客户文件" type="file" accept=".xlsx,.pdf" onChange={readFile} disabled={busy}/><button type="button" className="source-display" disabled={busy} aria-label={selectedFile || source?.filename ? `${selectedFile || source.filename}，点击更换文件` : '选择客户文件'} onClick={() => fileInput.current?.click()}><FileText size={30}/><strong aria-live="polite">{busy ? '正在读取文件…' : selectedFile || source?.filename || '暂未导入文件'}</strong><small>支持 .xlsx、文字型 PDF · 最大 {MAX_IMPORT_MB} MB</small></button>
      {!editing && data.intake_drafts?.length ? <div className="intake-draft-list"><strong>未完成草稿</strong>{data.intake_drafts.map(d => { const name = d.payload.form?.po || d.payload.source?.filename || '未命名草稿'; return <div className="intake-draft-row" key={d.id}><button type="button" className={`intake-draft-open ${intakeDraftId === d.id ? 'active' : ''}`} onClick={() => resumeDraft(d)}>{name}<small>{d.payload.lines?.length || 0} 项 · 继续填写</small></button><button type="button" className="intake-draft-delete" title={`删除草稿：${name}`} aria-label={`删除草稿：${name}`} disabled={busy} onClick={() => setDraftToDelete(d)}><Trash2 size={15}/></button></div>; })}</div> : null}
      {source?.filename ? <div className="source-file"><FileText size={18}/><span>{source.filename}</span><a href={`/api/files/${source.source_id}`} target="_blank" rel="noreferrer" aria-label="查看原文件"><ExternalLink size={16}/></a></div> : null}
      {source?.existing_orders?.length ? <p className="notice warning">此文件已关联 {source.existing_orders.length} 张已保存订单（{source.existing_orders.map(o => o.po).join("、")}），请核对后再建单。</p> : null}
      {(source?.warnings || []).filter(s => s !== '品牌、规格及数量请核对；源文件缺少的字段不会自动补造。').map((s, i) => <p className="notice" key={i}>{s}</p>)}
      {source?.metadata?.customer && !customers.some(c => c.name === source.metadata.customer) ? <p className="notice">文件客户：{source.metadata.customer}。请在客户列表中选择或新增对应客户。</p> : null}
      {source?.tables?.length ? <><Field label="工作表 / 页面"><select value={selected} onChange={e => { const i = Number(e.target.value); setSelected(i); setSelectedPo(''); setMapping(source.tables[i].mapping); }}>
        {source.tables.map((t, i) => <option value={i} key={i}>{t.title} · {t.rows.length} 行</option>)}</select></Field>
        {source.tables[selected].po_candidates?.length > 1 ? <Field label="选择本次导入的 PO"><select required value={selectedPo} onChange={e => setSelectedPo(e.target.value)}><option value="">请选择要追加或覆盖的 PO</option>{source.tables[selected].po_candidates.map(p => <option key={p}>{p}</option>)}</select></Field> : null}
        <div className="mapping">{FIELDS.map(([key, label]) => <Field key={key} label={label}><select value={mapping[key] ?? ''} onChange={e => setMapping(m => { const n = { ...m }; if (e.target.value === '') delete n[key]; else n[key] = Number(e.target.value); return n; })}><option value="">未提供</option>{source.tables[selected].headers.map((h, i) => <option value={i} key={i}>{i + 1}. {h || '空列'}</option>)}</select></Field>)}</div>
        <div className="sheet-actions"><Button secondary disabled={busy || (needsPo && !selectedPo) || appliedSheets.includes(sheetKey)} onClick={() => applySelected('append')}>追加到明细</Button><Button secondary disabled={busy || (needsPo && !selectedPo)} onClick={() => applySelected('replace')}>覆盖当前明细</Button></div>{appliedSheets.includes(sheetKey) ? <p className="muted sheet-hint">此工作表已加入明细；如需重新应用映射，请选择覆盖。</p> : null}</> : null}
      {source?.text ? <details className="raw-source"><summary>查看提取的原始内容</summary><pre>{source.text}</pre></details> : null}
      <details className="paste-box"><summary>从 Excel 粘贴明细</summary><p className="muted">连同表头复制，需包含“料品名称”和“数量”。</p><textarea aria-label="粘贴客户明细" rows={6} value={paste} onChange={e => setPaste(e.target.value)} placeholder={'料品名称\t料品规格\t数量\t单位'}/><Button secondary disabled={busy || !paste.trim()} onClick={readPaste}>解析粘贴内容</Button></details>
      <p className="muted footnote">扫描件 OCR 尚未接入，可对照原件手工录入。识别结果不会自动提交订单。</p>
    </Panel></div><form onSubmit={save}>{editing && editing.status === 'confirmed' ? <p className="notice">该订单已确认（第 {editing.version} 版）。保存会生成第 {editing.version + 1} 版并保持“已确认”，原版本仍保留在订单详情的报价历史中。</p> : null}<Panel title="核对客户订单" action={<div className="customer-actions"><Button secondary onClick={() => setCustomerEditor(true)}><Plus size={14}/>新增客户</Button></div>}><div className="form-grid order-header-grid">
      <Field label="客户名称 *"><SearchSelect label="客户名称" placeholder="请选择或输入客户名称" required value={form.customer_id || ''} options={customers.map(c => ({ value: c.id, label: c.name }))} onChange={id => chooseCustomer(customers.find(c => c.id === Number(id)))}/></Field>
      <Field label="客户 PO / 询价单号 *"><div className="po-field"><input required aria-label="客户 PO / 询价单号 *" readOnly={autoPo} value={form.po} placeholder={autoPo ? '按规则自动生成' : ''} onChange={e => patch('po', e.target.value)}/>{!editing ? <span className={`check-label po-auto ${companyCode ? '' : 'missing'}`} title={companyCode ? `按规则生成：PO + ${companyCode} + 日期 + 流水号` : '请先在“设置 · 公司信息”中填写公司代码，一般为 2 个字母'} onClick={e => { if (e.target.tagName !== 'INPUT') toggleAutoPo(!autoPo); }}><input type="checkbox" aria-label="按规则自动生成内部 PO 号" checked={autoPo} disabled={busy} onChange={e => toggleAutoPo(e.target.checked)}/><span>自动生成</span></span> : null}</div></Field>
      <Field label="联系人"><select value={contactIndex < 0 ? '' : contactIndex} onChange={e => { const c = contacts[Number(e.target.value)]; setForm(f => ({ ...f, contact: e.target.value === '' ? '' : c.name, phone: e.target.value === '' ? '' : c.phone })); setChecked(false); }}><option value="">{contacts.length ? '请选择联系人' : '请先在客户列表维护'}</option>{contacts.map((c, i) => <option key={i} value={i}>{c.name || '收货联系人'}{(!c.name || contacts.filter(x => x.name === c.name).length > 1) ? ` · ${c.phone}` : ''}</option>)}</select></Field>
      <InputField label="联系电话" readOnly value={form.phone} placeholder="随联系人自动带出"/>
      <Field label="收货地址 *"><div className="address-combobox" onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) { setAddressOpen(false); setAddressEditing(false); } }}><input role="combobox" aria-label="收货地址 *" aria-expanded={addressOpen && !!customer?.addresses.length} aria-controls="address-options" aria-autocomplete="list" required value={addressEditing || !form.address ? form.address : [form.contact, form.phone, form.address].filter(Boolean).join('　')} title={[form.contact, form.phone, form.address].filter(Boolean).join('　')} onFocus={() => { setAddressOpen(true); setAddressEditing(true); }} onClick={() => setAddressOpen(true)} onChange={e => patch('address', e.target.value)} placeholder="选择已保存地址或手动输入"/>{customer?.addresses.length ? <button type="button" className="address-toggle" aria-label="选择已保存地址" aria-expanded={addressOpen} onClick={() => setAddressOpen(open => !open)}><ChevronDown size={16}/></button> : null}{addressOpen && customer?.addresses.length ? <div id="address-options" className="address-options" role="listbox" aria-label="已保存的收货地址">{customer.addresses.map((a, i) => <button type="button" role="option" aria-selected={addressIndex === i} key={i} onClick={() => chooseAddress(i)} title={[a.contact, a.phone, a.address].filter(Boolean).join('　')}>{[a.contact, a.phone, a.address].filter(Boolean).join('　')}</button>)}</div> : null}</div></Field>
      <InputField label="期望交期" type="date" value={form.due_date} onChange={e => patch('due_date', e.target.value)}/>
      <Field label="业务员"><select aria-label="业务员" value={form.salesperson_id || ''} onChange={e => patch('salesperson_id', e.target.value === '' ? '' : Number(e.target.value))}><option value="">未指定</option>{salespeople.map(u => <option key={u.id} value={u.id}>{u.display_name}</option>)}</select></Field>
      <InputField label="订单备注" value={form.note} onChange={e => patch('note', e.target.value)}/>
    </div></Panel><Panel className="import-lines" data-hidden-columns={hiddenColumnsAttr} title={`料品明细 · ${lines.length} 项`} action={<div className="import-line-actions"><label className="check-label"><input type="checkbox" checked={checked} onChange={e => setChecked(e.target.checked)} required/>已核对料品、规格、数量与收货信息</label><ColumnSettings columns={IMPORT_COLUMNS} hidden={hiddenColumns} onToggle={toggleColumn} onReset={resetColumns}/><SaveBar busy={busy} label={editing && editing.status === 'confirmed' ? `保存为第 ${editing.version + 1} 版` : '保存订单'}>{!editing ? <Button secondary disabled={busy} onClick={saveDraft}>保存草稿</Button> : null}</SaveBar><Button secondary onClick={() => { setLines(x => [...x, blank()]); setChecked(false); }}><Plus size={15}/>添加料品</Button></div>}>
      <Table headers={[...FIELDS.flatMap(x => x[0] === 'price' ? ['单价','税率',x[1],'小计（含税）'] : x[0] === 'quantity' ? [x[1], '现存量', '可用库存'] : [x[1]]), '']} columnWidths={IMPORT_HEADER_KEYS.map((key, index) => hiddenColumns.has(key) ? 0 : IMPORT_WEIGHTS[index])}>
        <tr className="import-total-row"><td>合计</td><td/><td/><td/><td>{q(quantityTotal)}</td><td/><td/><td/><td/><td/><td/><td>{money(quoteTotalCents)}</td><td/><td/><td/><td/><td/></tr>
        {lines.map((line, i) => <tr key={i}>{FIELDS.map(([key, label]) => <React.Fragment key={key}>
          {key === 'price' ? <><td><input className="small-input" aria-label={`第${i + 1}行单价`} type="number" min="0" step="any" value={line.net_price ?? (line.price === '' || line.price == null ? '' : Number((Number(line.price) / (1 + (line.tax_rate ?? data.tax_settings?.default_rate ?? 13) / 100)).toFixed(6)))} onChange={e => changeLine(i, 'net_price', e.target.value)}/></td><td><select className="import-tax-select" aria-label={`第${i + 1}行税率`} value={line.tax_rate ?? data.tax_settings?.default_rate ?? 13} onChange={e => changeLine(i, 'tax_rate', Number(e.target.value))}>{[...new Set([...(data.tax_settings?.rates || [13,6,9]),line.tax_rate ?? data.tax_settings?.default_rate ?? 13])].map(rate => <option key={rate} value={rate}>{rate}%</option>)}</select></td></> : null}
          {['name','spec'].includes(key) ? <td><ItemSuggest items={data.items || []} value={line[key] ?? ''} ariaLabel={`第${i + 1}行${label}`} title={String(line[key] ?? '')} onPick={item => pickItem(i, item)} onChange={value => changeLine(i, key, value)}/></td> : <td><input title={String(line[key] ?? '')} aria-label={`第${i + 1}行${label}`} className={['quantity', 'price', 'unit'].includes(key) ? 'small-input' : 'cell-input'} value={key === 'quantity' && line[key] !== '' && line[key] != null ? Number(line[key]) : line[key] ?? ''} required={['name','quantity','unit'].includes(key)} type={['quantity','price'].includes(key) ? 'number' : 'text'} min={key === 'quantity' ? '.000001' : '0'} step={key === 'quantity' ? '.000001' : '.01'} onBlur={e => { if (key === 'quantity' && e.target.value !== '') { const value = String(Number(e.target.value)); e.target.value = value; changeLine(i, key, value); } }} onChange={e => changeLine(i, key, e.target.value)}/></td>}
          {key === 'quantity' ? <><td className="stock-cell" title="按型号匹配料品档案的仓库现存量">{stockRows[i] ? q(stockRows[i].on_hand) : '—'}</td><td className="stock-cell" title="现存量 − 全部订单占用">{stockRows[i] ? q(stockRows[i].available) : '—'}</td></> : null}
          {key === 'price' ? <td className="line-total">{money(lineTotalCents(line))}</td> : null}
        </React.Fragment>)}<td><button type="button" className="icon-button" aria-label={`删除第${i + 1}行`} disabled={lines.length === 1} onClick={() => { setLines(xs => xs.filter((_, j) => j !== i)); setChecked(false); }}><Trash2 size={16}/></button></td></tr>)}
      </Table>
    </Panel></form></div>{customerEditor ? <CustomerEditor run={run} busy={busy} onClose={() => setCustomerEditor(false)} onSaved={chooseCustomer}/> : null}{draftToDelete ? <Modal title="删除未完成草稿" onClose={() => setDraftToDelete(null)}><p>确定删除“{draftToDelete.payload.form?.po || draftToDelete.payload.source?.filename || '未命名草稿'}”？</p><p className="muted">只移除这条未完成草稿，不影响原始文件和已保存的客户订单。</p><div className="save-bar"><Button secondary onClick={() => setDraftToDelete(null)}>取消</Button><Button secondary danger disabled={busy} onClick={() => deleteDraft(draftToDelete)}>删除草稿</Button></div></Modal> : null}</>;
}

