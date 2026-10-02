// Imports (task 2.7, product.md §7.2 module "Imports"): upload a catalogue workbook to check it, then open the import to
// review and confirm. Past imports are listed with their outcome. Inventory imports arrive with task 2.8.
import { useQuery } from '@tanstack/react-query';
import { Download, FileSpreadsheet } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { saveBlob, uploadWorkbook } from '../../api/upload';
import { useAuth } from '../../auth/AuthProvider';
import { btn } from '../../components/dialogs';
import { errorMessage } from '../../components/feedback';
import { FormAlert } from '../../components/form';
import { PageHeader } from '../simple';
import { ImportStatus, type ImportView } from './parts';

const dateTime = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

export function ImportsPage() {
  const { api, state } = useAuth();
  const navigate = useNavigate();
  const canCatalog = state.status === 'authenticated' && state.permissions.includes('imports:catalog');
  const [file, setFile] = useState<File | null>(null);
  const [createMissing, setCreateMissing] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = useQuery({ queryKey: ['imports'], queryFn: () => api.request<{ data: ImportView[] }>('GET', '/admin/imports', { query: { limit: 20 } }), enabled: canCatalog });

  const start = async () => {
    if (!file) { setError('Choose the .xlsx file to import'); return; }
    setBusy(true); setError(null);
    try {
      const fileMediaId = await uploadWorkbook(api, file);
      const imp = await api.request<ImportView>('POST', '/admin/imports', { body: { kind: 'CATALOG', fileMediaId, createMissing, fileName: file.name } });
      await navigate(`/imports/${imp.id}`);
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };
  const template = async () => {
    try { saveBlob(await api.download('/admin/imports/template.xlsx'), 'artq-catalogue-template.xlsx'); } catch (e) { setError(errorMessage(e)); }
  };

  if (!canCatalog) {
    return <><PageHeader title="Imports" /><p className="text-ink-700">Inventory count imports arrive with the Inventory module (task 2.8).</p></>;
  }
  return (
    <>
      <PageHeader title="Imports">
        <button type="button" className={`${btn} border border-border-input text-ink-900 hover:bg-surface-100`} onClick={() => void template()}><Download aria-hidden size={16} className="mr-2" />Download template</button>
      </PageHeader>
      <section aria-labelledby="new-import" className="mb-6 rounded-lg border border-surface-200 bg-white p-5">
        <h2 id="new-import" className="text-lg font-semibold text-ink-900">Import the catalogue from a spreadsheet</h2>
        <p className="mt-1 max-w-2xl text-sm text-ink-700">
          The file is checked first and nothing changes until you confirm. Products are created as drafts. Stock in the sheet is kept but must be
          counted before publishing; a re-import never changes stock or whether a product is live. The client&apos;s “Sheet1” and the official template both work.
        </p>
        <div className="mt-4 flex flex-wrap items-end gap-4">
          <div>
            <label htmlFor="import-file" className="block text-sm font-medium text-ink-900">Workbook (.xlsx, up to 5 MB)</label>
            <input id="import-file" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setError(null); }}
              aria-invalid={error && !file ? true : undefined} aria-describedby={error ? 'import-error' : undefined}
              className="mt-1 block text-sm text-ink-900 file:mr-3 file:h-11 file:rounded-md file:border file:border-border-input file:bg-white file:px-4 file:font-medium" />
          </div>
          <label className="flex items-center gap-2 text-sm text-ink-900">
            <input type="checkbox" className="h-4 w-4 accent-brand-700" checked={createMissing} onChange={(e) => setCreateMissing(e.target.checked)} />
            Create missing product types, categories and techniques
          </label>
          <button type="button" disabled={busy} aria-busy={busy || undefined} className={`${btn} bg-brand-700 text-white disabled:opacity-80`} onClick={() => void start()}>
            <FileSpreadsheet aria-hidden size={16} className="mr-2" />{busy ? 'Uploading…' : 'Check file'}
          </button>
        </div>
        {error && <div id="import-error" className="mt-3"><FormAlert>{error}</FormAlert></div>}
      </section>
      <div className="overflow-x-auto rounded-lg border border-surface-200 bg-white">
        <table className="w-full border-collapse text-left text-sm">
          <caption className="sr-only">Past imports</caption>
          <thead className="bg-surface-100 text-ink-700">
            <tr><th scope="col" className="px-4 py-3 font-semibold">File</th><th scope="col" className="px-4 py-3 font-semibold">Started</th><th scope="col" className="px-4 py-3 font-semibold">Status</th><th scope="col" className="px-4 py-3 font-semibold">Rows</th><th scope="col" className="px-4 py-3 font-semibold">Result</th></tr>
          </thead>
          <tbody>
            {list.isPending && <tr><td colSpan={5} className="px-4 py-6 text-center text-ink-700">Loading…</td></tr>}
            {list.data?.data.length === 0 && <tr><td colSpan={5} className="px-4 py-6 text-center text-ink-700">No imports yet.</td></tr>}
            {list.data?.data.map((i) => (
              <tr key={i.id} className="border-t border-surface-200">
                <td className="px-4 py-2"><Link to={`/imports/${i.id}`} className="font-medium text-brand-700 underline">{i.fileName}</Link></td>
                <td className="whitespace-nowrap px-4 py-2 text-ink-700">{dateTime.format(new Date(i.createdAt))}</td>
                <td className="px-4 py-2"><ImportStatus status={i.status} /></td>
                <td className="px-4 py-2 tabular-nums">{i.totalRows}</td>
                <td className="px-4 py-2 tabular-nums text-ink-700">{i.status.startsWith('COMPLETED') ? `${i.createdCount} created · ${i.updatedCount} updated · ${i.unchangedCount} unchanged${i.reviewCount ? ` · ${i.reviewCount} to review` : ''}${i.failedCount ? ` · ${i.failedCount} failed` : ''}` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
