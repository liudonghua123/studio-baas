import { useEffect, useMemo, useState } from 'react';
import { BookOpen, Download, FileText, ArrowUpRight } from 'lucide-react';
import { api } from '../api';
import { Loading, useToast } from '../components/ui';
import { renderMarkdown } from '../lib/markdown';

export default function Docs() {
  const toast = useToast();
  const [md, setMd] = useState<string | null>(null);
  const [title, setTitle] = useState('Analysis');
  const [active, setActive] = useState('');

  useEffect(() => {
    api.docs()
      .then((d) => { setMd(d.markdown); setTitle(d.title.replace('.md', '')); })
      .catch((e) => toast.push(e.message, 'err'));
  }, []);

  const { html, toc } = useMemo(() => (md ? renderMarkdown(md) : { html: '', toc: [] }), [md]);

  const jump = (id: string) => {
    setActive(id);
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="eyebrow"><BookOpen size={11} /> Research</div>
          <h1>Appwrite core functionality</h1>
          <p>A complete product teardown: services, architecture, pricing model, and how this studio re-implements each capability in TypeScript.</p>
        </div>
        <div className="page-actions">
          <a className="btn ghost" href="/v1/docs/raw"><Download size={14} /> Download markdown</a>
        </div>
      </div>

      {!md ? <div className="card"><Loading rows={8} /></div> : (
        <div className="docs-layout">
          <aside className="docs-toc">
            <div className="tiny dim" style={{ padding: '0 0 8px 10px', letterSpacing: '.1em', textTransform: 'uppercase', fontSize: 9.5 }}>On this page</div>
            {toc.filter((t) => t.level <= 3).map((t) => (
              <a key={t.id} href={`#${t.id}`} className={`l${t.level} ${active === t.id ? 'active' : ''}`}
                style={active === t.id ? { color: 'var(--text)', borderLeftColor: 'var(--pink)' } : {}}
                onClick={(e) => { e.preventDefault(); jump(t.id); }}>
                {t.text}
              </a>
            ))}
            <div style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--line)' }}>
              <div className="flex tiny dim" style={{ gap: 5 }}><FileText size={11} /> {title}</div>
              <a className="flex tiny" style={{ gap: 4, marginTop: 8, color: '#ff8aa6' }} href="https://appwrite.io" target="_blank" rel="noreferrer">
                appwrite.io <ArrowUpRight size={10} />
              </a>
            </div>
          </aside>
          <article className="docs-body" dangerouslySetInnerHTML={{ __html: html }} />
        </div>
      )}
    </div>
  );
}
