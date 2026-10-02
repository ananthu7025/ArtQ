// Description editor (product.md §7.4 "rich text"). TipTap limited to what the server keeps (apps/api/src/catalog/
// rich-text.ts): paragraphs, bold, italic, underline, strike, headings 3–4, lists, quotes, links. The server sanitises again.
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Bold, Heading3, Italic, Link2, List, ListOrdered, Quote, Underline } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';

type Props = { id: string; label: string; value: string; onChange: (html: string) => void; error?: string | undefined };

export function RichText({ id, label, value, onChange, error }: Props) {
  const editor = useEditor({
    extensions: [StarterKit.configure({
      heading: { levels: [3, 4] }, code: false, codeBlock: false, horizontalRule: false,
      link: { openOnClick: false, autolink: true, protocols: ['https', 'http', 'mailto'], HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' } },
    })],
    content: value,
    editorProps: {
      attributes: {
        id, role: 'textbox', 'aria-multiline': 'true', 'aria-labelledby': `${id}-label`,
        ...(error ? { 'aria-invalid': 'true', 'aria-describedby': `${id}-error` } : {}),
        class: 'prose-sm min-h-40 rounded-b-md border border-border-input bg-white px-3 py-2 text-ink-900 outline-none focus-visible:outline-2 focus-visible:outline-brand-700 [&_h3]:text-lg [&_h3]:font-semibold [&_h4]:font-semibold [&_ol]:list-decimal [&_ol]:pl-6 [&_ul]:list-disc [&_ul]:pl-6 [&_blockquote]:border-l-4 [&_blockquote]:pl-3 [&_a]:text-brand-700 [&_a]:underline',
      },
    },
    onUpdate: ({ editor: e }) => onChange(e.isEmpty ? '' : e.getHTML()),
    immediatelyRender: true,
  });

  // An outside reset (Reload after a conflict) replaces the content without echoing back.
  useEffect(() => {
    if (!editor) return;
    const current = editor.isEmpty ? '' : editor.getHTML();
    if (value !== current) editor.commands.setContent(value, { emitUpdate: false });
  }, [editor, value]);

  const tool = (name: string, icon: ReactNode, active: boolean, run: () => void) => (
    <button type="button" aria-label={name} aria-pressed={active} title={name} onMouseDown={(e) => e.preventDefault()} onClick={run}
      className={`inline-flex h-9 w-9 items-center justify-center rounded ${active ? 'bg-brand-50 text-brand-800' : 'text-ink-900 hover:bg-surface-100'}`}>{icon}</button>
  );
  const link = () => {
    if (!editor) return;
    if (editor.isActive('link')) { editor.chain().focus().unsetLink().run(); return; }
    const href = window.prompt('Link address (https://…)');
    if (href && /^(https?:\/\/|mailto:)/i.test(href)) editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
  };

  return (
    <div>
      <span id={`${id}-label`} className="block text-sm font-medium text-ink-900">{label}</span>
      <div className={`mt-1 flex flex-wrap gap-1 rounded-t-md border border-b-0 ${error ? 'border-danger-700' : 'border-border-input'} bg-surface-50 p-1`} role="toolbar" aria-label={`${label} formatting`}>
        {editor && <>
          {tool('Bold', <Bold aria-hidden size={16} />, editor.isActive('bold'), () => editor.chain().focus().toggleBold().run())}
          {tool('Italic', <Italic aria-hidden size={16} />, editor.isActive('italic'), () => editor.chain().focus().toggleItalic().run())}
          {tool('Underline', <Underline aria-hidden size={16} />, editor.isActive('underline'), () => editor.chain().focus().toggleUnderline().run())}
          {tool('Heading', <Heading3 aria-hidden size={16} />, editor.isActive('heading', { level: 3 }), () => editor.chain().focus().toggleHeading({ level: 3 }).run())}
          {tool('Bulleted list', <List aria-hidden size={16} />, editor.isActive('bulletList'), () => editor.chain().focus().toggleBulletList().run())}
          {tool('Numbered list', <ListOrdered aria-hidden size={16} />, editor.isActive('orderedList'), () => editor.chain().focus().toggleOrderedList().run())}
          {tool('Quote', <Quote aria-hidden size={16} />, editor.isActive('blockquote'), () => editor.chain().focus().toggleBlockquote().run())}
          {tool('Link', <Link2 aria-hidden size={16} />, editor.isActive('link'), link)}
        </>}
      </div>
      <EditorContent editor={editor} />
      {error && <p id={`${id}-error`} className="mt-1 text-sm text-danger-700">{error}</p>}
    </div>
  );
}
