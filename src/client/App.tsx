import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowDown, ArrowDownToLine, ArrowRight, ArrowUp, Bot, Check, ChevronDown, ChevronRight, Circle, Clock3, Code2, Compass, ExternalLink, Eye, Globe2, Hash, LoaderCircle, Menu, MessageCircle, MessagesSquare, MoreHorizontal, Pencil, Pause, Play, Plus, Radio, Settings2, Sparkles, Square, Terminal, Users, Workflow, X } from 'lucide-react';
import { DEFAULT_SETTINGS, type Activity, type Conversation, type CreateSessionInput, type Identity, type Message, type Participant, type RuntimeHealth, type Session, type Snapshot } from '../shared/types';
import { api, downloadSession, readIdentity, saveIdentity, withIdentityRecovery } from './api';
import { subscribeSessionEvents } from './session-events';
import { RunLimits } from './RunLimits';

const agentColors = ['#d5e5a7', '#aecfcb', '#d9bd9f', '#c1b5df', '#a6c3db'];
const suggestedAgents = [
  { name: 'Fox', instructions: 'Coordinate the collaboration. Clarify the task, propose an approach, and bring together the team’s conclusions.', webFetch: true },
  { name: 'Horse', instructions: 'Investigate the details. Find evidence, examine assumptions, and share useful discoveries with the team.', webFetch: true },
  { name: 'Pig', instructions: 'Explore alternative perspectives. Challenge classifications, identify gaps, and suggest better ways to organize the work.', webFetch: true },
  { name: 'Owl', instructions: 'Review the quality of the work. Test conclusions against evidence and call out unresolved questions.', webFetch: true },
  { name: 'Otter', instructions: 'Look for connections across the work. Suggest useful patterns, categories, and synthesis.', webFetch: true },
];
type ConversationSelection = { kind: 'group' } | { kind: 'conversation'; id: string } | { kind: 'person'; id: string };
type Control = 'start' | 'pause' | 'resume' | 'next-round' | 'pause-agent' | 'resume-agent';
const initialSelection: ConversationSelection = { kind: 'group' };

function Logo({ compact = false }: { compact?: boolean }) {
  return <div className="brand"><svg aria-hidden="true" width="30" height="30" viewBox="0 0 36 36" fill="none"><path d="M5 27V12L18 21L31 12V27M5 12L18 4L31 12" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" /></svg>{!compact && <span>mindspace<span className="brand-dot">.</span></span>}</div>;
}
function Avatar({ participant, size = '' }: { participant: Pick<Participant, 'name' | 'kind' | 'color'>; size?: string }) {
  return <span className={`avatar ${size} ${participant.kind}`} style={{ '--avatar-color': participant.color || '#a4b9ae' } as React.CSSProperties}>{participant.kind === 'agent' ? <Bot size={size === 'large' ? 24 : 18} strokeWidth={1.7} /> : participant.name.slice(0, 2).toUpperCase()}</span>;
}
function Status({ status }: { status: string }) { return <span className={`status-label ${status}`}><i />{status === 'tool' ? 'Using a tool' : status === 'thinking' ? 'Thinking' : status === 'queued' ? 'In queue' : status.charAt(0).toUpperCase() + status.slice(1)}</span>; }
function formatTime(value: string) { return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
function formatNumber(value: number | null) { return value === null ? '—' : new Intl.NumberFormat().format(value); }
function errorText(error: unknown) { return error instanceof Error ? error.message : 'Something went wrong. Please try again.'; }

export default function App() {
  const [identity, setIdentity] = useState<Identity | null>(readIdentity);
  const [health, setHealth] = useState<RuntimeHealth | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [selection, setSelection] = useState<ConversationSelection>(initialSelection);
  const [inspectedId, setInspectedId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [renameTarget, setRenameTarget] = useState<Session | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showAddAgent, setShowAddAgent] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const sessionRef = useRef<string | null>(null);
  const cursorRef = useRef(0);
  const hasRestoredSession = useRef(false);
  const identityRef = useRef(identity);
  const stopSessionEvents = useRef<(() => void) | null>(null);

  const invalidateIdentity = useCallback(() => {
    identityRef.current = null; sessionRef.current = null; cursorRef.current = 0; hasRestoredSession.current = false;
    stopSessionEvents.current?.(); stopSessionEvents.current = null;
    setIdentity(null); setSessions([]); setSnapshot(null); setSelection(initialSelection); setInspectedId(null);
    setShowCreate(false); setRenameTarget(null); setShowSettings(false); setShowAddAgent(false); setShowFiles(false); setSidebarOpen(false); setLoading(false); setBusy(false); setConnected(false);
    setError('Your saved browser identity is no longer valid. Enter your name to continue.');
  }, []);
  const request = useCallback(<T,>(path: string, requestIdentity: Identity | null, options: RequestInit = {}) => withIdentityRecovery(requestIdentity, () => identityRef.current, invalidateIdentity, () => api<T>(path, requestIdentity, options)), [invalidateIdentity]);

  const receiveSnapshot = useCallback((value: Snapshot) => {
    if (sessionRef.current !== value.session.id) return;
    setSnapshot(previous => previous?.session.id === value.session.id && previous.eventSeq > value.eventSeq ? previous : value);
    cursorRef.current = Math.max(cursorRef.current, value.eventSeq);
    setSessions(previous => [value.session, ...previous.filter(s => s.id !== value.session.id)].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  }, []);
  const openSession = useCallback(async (sessionId: string) => {
    if (!identity) return;
    sessionRef.current = sessionId; cursorRef.current = 0;
    setLoading(true); setError(null); setSnapshot(null); setSelection(initialSelection); setInspectedId(null); setSidebarOpen(false);
    try {
      await request(`/sessions/${sessionId}/join`, identity, { method: 'POST' });
      const value = await request<Snapshot>(`/sessions/${sessionId}`, identity);
      if (sessionRef.current !== sessionId) return;
      receiveSnapshot(value); setInspectedId(window.innerWidth > 930 ? value.participants.find(p => p.kind === 'agent')?.id ?? null : null);
      localStorage.setItem('mindspace.session', sessionId);
    } catch (failure) { if (sessionRef.current === sessionId && identityRef.current?.token === identity.token) setError(errorText(failure)); }
    finally { if (sessionRef.current === sessionId && identityRef.current?.token === identity.token) setLoading(false); }
  }, [identity, receiveSnapshot, request]);

  useEffect(() => {
    let active = true;
    const fetchHealth = () => api<RuntimeHealth>('/health', null).then(value => { if (active) setHealth(value); }).catch(() => { if (active) setHealth(null); });
    void fetchHealth(); const timer = setInterval(fetchHealth, 30000);
    return () => { active = false; clearInterval(timer); };
  }, []);
  useEffect(() => {
    if (!identity) return;
    let active = true;
    void request<Session[]>('/sessions', identity).then(values => {
      if (!active || identityRef.current?.token !== identity.token) return; setSessions(values);
      if (!hasRestoredSession.current) {
        hasRestoredSession.current = true;
        const saved = localStorage.getItem('mindspace.session');
        if (saved && values.some(s => s.id === saved)) void openSession(saved);
      }
    }).catch(failure => { if (active && identityRef.current?.token === identity.token) setError(errorText(failure)); });
    return () => { active = false; };
  }, [identity, openSession, request]);
  const sessionId = snapshot?.session.id;
  useEffect(() => {
    if (!sessionId || !identity) { setConnected(false); return; }
    const stop = subscribeSessionEvents({
      sessionId,
      getCursor: () => cursorRef.current,
      fetchSnapshot: signal => request<Snapshot>(`/sessions/${sessionId}`, identity, { signal }),
      receiveSnapshot,
      setConnected,
      isCurrent: () => sessionRef.current === sessionId && identityRef.current?.token === identity.token,
    });
    stopSessionEvents.current = stop;
    return () => { stop(); if (stopSessionEvents.current === stop) stopSessionEvents.current = null; };
  }, [sessionId, identity, receiveSnapshot, request]);

  async function createSession(input?: CreateSessionInput) {
    if (!identity) return;
    const value = await request<Snapshot>(input ? '/sessions' : '/sessions/arxiv', identity, { method: 'POST', ...(input ? { body: JSON.stringify(input) } : {}) });
    if (identityRef.current?.token !== identity.token) return;
    sessionRef.current = value.session.id; cursorRef.current = value.eventSeq; receiveSnapshot(value);
    setSelection(initialSelection); setInspectedId(window.innerWidth > 930 ? value.participants.find(p => p.kind === 'agent')?.id ?? null : null); setShowCreate(false); setError(null);
    localStorage.setItem('mindspace.session', value.session.id);
    if (!input) {
      setBusy(true);
      try { receiveSnapshot(await request<Snapshot>(`/sessions/${value.session.id}/control`, identity, { method: 'POST', body: JSON.stringify({ action: 'start' }) })); }
      catch (failure) { if (identityRef.current?.token === identity.token) setError(`The experiment was created. ${errorText(failure)} Use Start to retry.`); }
      finally { if (identityRef.current?.token === identity.token) setBusy(false); }
    }
  }
  async function control(action: Control, agentId?: string) {
    if (!snapshot || !identity) return;
    setBusy(true); setError(null);
    try { receiveSnapshot(await request<Snapshot>(`/sessions/${snapshot.session.id}/control`, identity, { method: 'POST', body: JSON.stringify({ action, agentId }) })); }
    catch (failure) { if (identityRef.current?.token === identity.token) setError(errorText(failure)); } finally { if (identityRef.current?.token === identity.token) setBusy(false); }
  }
  async function send(body: string, target: { conversationId?: string; recipientId?: string }, requestId: string) {
    if (!snapshot || !identity) throw new Error('Join a session before sending a message.');
    const currentId = snapshot.session.id;
    await request(`/sessions/${currentId}/messages`, identity, { method: 'POST', body: JSON.stringify({ body, ...target, requestId }) });
    void request<Snapshot>(`/sessions/${currentId}`, identity).then(receiveSnapshot).catch(() => {
      // The stream subscription owns refresh recovery and connection status.
    });
  }
  async function exportSession() {
    if (!snapshot || !identity) return;
    try { await withIdentityRecovery(identity, () => identityRef.current, invalidateIdentity, () => downloadSession(snapshot.session.id, snapshot.session.title, identity)); }
    catch (failure) { if (identityRef.current?.token === identity.token) setError(errorText(failure)); }
  }
  function selectConversation(value: ConversationSelection) { setSelection(value); setSidebarOpen(false); }
  const agents = snapshot?.participants.filter(p => p.kind === 'agent') ?? [];
  const humans = snapshot?.participants.filter(p => p.kind === 'human') ?? [];
  const group = snapshot?.conversations.find(c => c.kind === 'group');
  const ownId = identity?.id;
  const selectedConversation = selection.kind === 'group' ? group : selection.kind === 'conversation' ? snapshot?.conversations.find(c => c.id === selection.id) : snapshot?.conversations.find(c => c.kind === 'dm' && c.participantIds.includes(ownId ?? '') && c.participantIds.includes(selection.id));
  const recipient = selection.kind === 'person' ? snapshot?.participants.find(p => p.id === selection.id) : selectedConversation?.kind === 'dm' && selectedConversation.participantIds.includes(ownId ?? '') ? snapshot?.participants.find(p => selectedConversation.participantIds.includes(p.id) && p.id !== ownId) : undefined;
  const canCompose = selection.kind === 'group' || !!recipient;
  const selectedMessages = snapshot?.messages.filter(message => message.conversationId === selectedConversation?.id) ?? [];
  const selectedPeople = selectedConversation?.participantIds.map(id => snapshot?.participants.find(p => p.id === id)).filter((p): p is Participant => !!p) ?? (recipient ? [recipient] : []);
  const chatName = selection.kind === 'group' ? 'The commons' : recipient?.name ?? (selectedPeople.map(p => p.name).join(' & ') || 'Direct message');
  const inspected = agents.find(p => p.id === inspectedId);

  return <div className="app-shell">
    {sidebarOpen && <button className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} aria-label="Close navigation" />}
    <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
      <div className="sidebar-brand"><Logo /><button className="icon-button mobile-close" onClick={() => setSidebarOpen(false)} aria-label="Close navigation"><X size={18} /></button></div>
      <div className="workspace-label"><span className="workspace-symbol"><Workflow size={14} /></span> Research workspace <span className="local-tag">LOCAL</span></div>
      <button className="new-session-button" onClick={() => setShowCreate(true)} disabled={!identity}><Plus size={17} /> New experiment <span>↗</span></button>
      <div className="sidebar-section-label">EXPERIMENTS <span>{sessions.length.toString().padStart(2, '0')}</span></div>
      <nav className="session-list" aria-label="Experiments">
        {sessions.map(s => <div key={s.id} className={`session-row ${snapshot?.session.id === s.id ? 'selected' : ''}`}><button className="session-link" onClick={() => void openSession(s.id)} title={s.title}><span className={`session-dot ${s.status}`} /><span>{s.title}</span></button><button className="icon-button session-rename" title={`Rename ${s.title}`} aria-label={`Rename ${s.title}`} onClick={() => setRenameTarget(s)}><Pencil size={13} /></button></div>)}
        {!sessions.length && <p className="sidebar-empty">Your experiments will live here.</p>}
      </nav>
      {snapshot && <>
        <div className="sidebar-section-label">CONVERSATIONS <MessagesSquare size={13} /></div>
        <nav className="conversation-list" aria-label="Conversations">
          <button className={`conversation-link ${selection.kind === 'group' ? 'selected' : ''}`} onClick={() => selectConversation(initialSelection)}><Hash size={17} /><span>The commons</span><span className="count">{snapshot.messages.filter(m => m.conversationId === group?.id).length}</span></button>
          {snapshot.conversations.filter(c => c.kind === 'dm').map(conversation => <DMNavigation key={conversation.id} conversation={conversation} participants={snapshot.participants} selected={selectedConversation?.id === conversation.id} onClick={() => selectConversation({ kind: 'conversation', id: conversation.id })} />)}
          {!snapshot.conversations.some(c => c.kind === 'dm') && <p className="sidebar-empty small">Direct conversations appear here.</p>}
        </nav>
        <div className="sidebar-section-label">AGENTS <span>{agents.length} MEMBERS</span></div>
        <nav className="agent-list" aria-label="Agent activity">
          {agents.map(agent => <button key={agent.id} className={`agent-link ${inspectedId === agent.id ? 'inspected' : ''}`} onClick={() => { setInspectedId(agent.id); setSidebarOpen(false); }}><Avatar participant={agent} /><span><strong>{agent.name}</strong><span>{agent.status === 'tool' ? 'Using a tool' : agent.status.charAt(0).toUpperCase() + agent.status.slice(1)}</span></span><i className={`presence ${agent.status}`} /></button>)}
        </nav>
        {agents.length < 5 && <button className="add-agent" onClick={() => setShowAddAgent(true)}><Plus size={14} /> Add agent</button>}
      </>}
      <div className="sidebar-footer">
        <div className="runtime-status"><i className={health?.available ? 'online' : ''} />{health?.mode === 'simulation' ? 'Simulation runtime' : health?.available ? 'Codex connected' : health ? 'Codex unavailable' : 'Connecting to server'}<span title={health?.version}>{health?.version ? '↗' : ''}</span></div>
        <div className="identity"><Avatar participant={{ name: identity?.name ?? 'You', kind: 'human', color: '#b5c5b1' }} /><span><strong>{identity?.name ?? 'Welcome'}</strong><span>Human observer</span></span><span className="human-badge">YOU</span></div>
      </div>
    </aside>
    <div className="main-shell">
      <header className="topbar"><div className="breadcrumb"><button className="icon-button mobile-menu" aria-label="Open navigation" onClick={() => setSidebarOpen(true)}><Menu size={19} /></button><span className="breadcrumb-root">Workspace</span><ChevronRight size={13} /><strong>{snapshot?.session.title ?? 'Overview'}</strong></div><div className="topbar-actions"><span className={`connection ${connected ? 'live' : ''}`}><Radio size={13} />{snapshot ? connected ? 'Live session' : 'Reconnecting' : 'Local development'}</span>{snapshot && <><button className="icon-button" title="Session settings" aria-label="Session settings" onClick={() => setShowSettings(true)}><Settings2 size={17} /></button><button className="icon-button" title="Export experiment" aria-label="Export experiment" onClick={() => void exportSession()}><ArrowDownToLine size={17} /></button></>}</div></header>
      {error && <div className="error-banner" role="alert"><span>{error}</span><button className="icon-button" aria-label="Dismiss error" onClick={() => setError(null)}><X size={16} /></button></div>}
      {health?.mode === 'simulation' && <div className="simulation-banner"><Code2 size={15} /><strong>Simulation mode</strong><span>Scripted agents for testing. No model is running.</span></div>}
      {health && !health.available && <div className="runtime-banner"><Terminal size={16} /><span><strong>Runtime needs attention.</strong> {health.message ?? 'Codex is unavailable. You can create a session and chat while the runtime is configured.'}</span></div>}
      {loading ? <div className="loading-state"><LoaderCircle className="spin" size={26} /><p>Opening your experiment…</p></div> : snapshot ? <>
        <section className="session-heading"><div><div className="eyebrow">COLLABORATIVE EXPERIMENT <span> / {snapshot.session.id.slice(0, 6).toUpperCase()}</span></div><div className="experiment-title"><h1>{snapshot.session.title}</h1><button className="icon-button" title="Rename experiment" aria-label="Rename experiment" onClick={() => setRenameTarget(snapshot.session)}><Pencil size={17} /></button></div><p>{agents.length} independent minds. One shared space.</p></div><div className="session-heading-right"><div className="avatar-stack">{agents.map(agent => <Avatar key={agent.id} participant={agent} />)}<span className="human-count"><Users size={13} />{humans.length}</span></div><span className="model-pill">Terra 5.6 <span>HIGH</span></span></div></section>
        <div className="paper-progress"><span>{snapshot.paperProgress ? `${formatNumber(snapshot.paperProgress.reviewed)} reviewed · ${formatNumber(snapshot.paperProgress.unavailable)} unavailable · ${formatNumber(snapshot.paperProgress.pending)} remaining / ${formatNumber(snapshot.paperProgress.total)} papers` : 'One shared directory for every agent'}</span><button className="text-button" onClick={() => setShowFiles(true)}>Shared files <ArrowRight size={13} /></button></div>
        <RoundBar snapshot={snapshot} busy={busy} runtimeAvailable={!!health?.available} onControl={control} />
        <div className={`workspace-grid ${!inspected ? 'inspector-hidden' : ''}`}>
          <section className="chat-panel">
            <div className="panel-heading"><div className="chat-title-icon">{selection.kind === 'group' ? <Hash size={21} /> : <MessageCircle size={21} />}</div><div><h2>{chatName}</h2><p>{selection.kind === 'group' ? 'The shared conversation' : 'Direct conversation · Visible to all humans'}</p></div><span className="chat-count">{selectedMessages.length} messages</span></div>
            <ChatLog key={selectedConversation?.id ?? `${selection.kind}-${recipient?.id}`} messages={selectedMessages} participants={snapshot.participants} ownId={ownId} task={selection.kind === 'group' ? snapshot.session.task : undefined} recipientName={recipient?.name} onInspect={id => setInspectedId(id)} />
            <div className="composer-area">{canCompose ? <Composer key={`${snapshot.session.id}:${selection.kind === 'group' ? 'group' : recipient?.id}`} placeholder={selection.kind === 'group' ? 'Bring a thought to the commons…' : `Message ${recipient?.name}…`} label={selection.kind === 'group' ? 'Message the group' : `Message ${recipient?.name}`} onSend={(body, requestId) => send(body, recipient ? { recipientId: recipient.id } : { conversationId: group?.id }, requestId)} footer={selection.kind === 'group' ? 'Everyone in this experiment can see your message.' : 'Direct messages can steer an agent while it works.'} /> : <div className="observer-notice"><Eye size={17} /><span>You’re observing this conversation.</span>{selectedPeople.some(p => p.kind === 'agent') && <button onClick={() => { const agent = selectedPeople.find(p => p.kind === 'agent'); if (agent) { setInspectedId(agent.id); selectConversation({ kind: 'person', id: agent.id }); } }}>Message an agent <ArrowRight size={13} /></button>}</div>}</div>
          </section>
          {inspected && <AgentInspector key={`${snapshot.session.id}:${inspected.id}`} agent={inspected} agents={agents} activities={snapshot.activities.filter(a => a.agentId === inspected.id && a.title !== 'userMessage')} pending={snapshot.deliveries.filter(d => d.agentId === inspected.id && d.state !== 'accepted').length} uncertain={snapshot.deliveries.filter(d => d.agentId === inspected.id && d.state === 'uncertain').length} onSelect={setInspectedId} onClose={() => setInspectedId(null)} onControl={control} busy={busy} onSend={(body, requestId) => send(body, { recipientId: inspected.id }, requestId)} onOpenChat={() => selectConversation({ kind: 'person', id: inspected.id })} />}
          {!inspected && <button className="reopen-inspector" onClick={() => setInspectedId(agents[0]?.id ?? null)}><Bot size={17} /> Open agent activity <ChevronRight size={15} /></button>}
        </div>
      </> : <Welcome onCreate={() => setShowCreate(true)} disabled={!identity} />}
    </div>
    {!identity && <IdentityDialog onSubmit={async name => { const value = await api<Identity>('/identities', null, { method: 'POST', body: JSON.stringify({ name }) }); saveIdentity(value); identityRef.current = value; setIdentity(value); setError(null); }} />}
    {showCreate && identity && <CreateDialog onClose={() => setShowCreate(false)} onSubmit={createSession} mode={health?.mode} getImportProgress={() => request<{ loaded: number; total: number }>('/arxiv/progress', identity)} />}
    {showAddAgent && snapshot && identity && <AddAgentDialog onClose={() => setShowAddAgent(false)} onSubmit={async input => { const value = await request<Snapshot>(`/sessions/${snapshot.session.id}/agents`, identity, { method: 'POST', body: JSON.stringify(input) }); receiveSnapshot(value); setShowAddAgent(false); }} />}
    {showFiles && snapshot && identity && <SharedFilesDialog key={snapshot.session.id} onClose={() => setShowFiles(false)} fileUrl={`/api/sessions/${snapshot.session.id}/files`} load={(path = '') => request<any>(`/sessions/${snapshot.session.id}/files${path}`, identity)} />}
    {renameTarget && identity && <RenameDialog key={renameTarget.id} title={renameTarget.title} onClose={() => setRenameTarget(null)} onSubmit={async title => { await request(`/sessions/${renameTarget.id}/join`, identity, { method: 'POST' }); const value = await request<Snapshot>(`/sessions/${renameTarget.id}`, identity, { method: 'PATCH', body: JSON.stringify({ title }) }); setSessions(previous => previous.map(session => session.id === value.session.id ? value.session : session)); receiveSnapshot(value); setRenameTarget(null); }} />}
    {showSettings && snapshot && <SettingsDialog snapshot={snapshot} onClose={() => setShowSettings(false)} />}
  </div>;
}

function RenameDialog({ title: initialTitle, onSubmit, onClose }: { title: string; onSubmit: (title: string) => Promise<void>; onClose: () => void }) {
  const [title, setTitle] = useState(initialTitle);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <Modal title="Rename experiment" onClose={busy ? undefined : onClose}><form className="create-form" onSubmit={async event => {
    event.preventDefault(); setBusy(true); setError('');
    try { await onSubmit(title.trim()); } catch (failure) { setError(errorText(failure)); setBusy(false); }
  }}><label>Experiment name<input autoFocus value={title} onChange={event => setTitle(event.target.value)} maxLength={160} required disabled={busy} /></label>{error && <p className="form-error" role="alert">{error}</p>}<button className="primary-button full-width" disabled={busy || !title.trim()} type="submit">{busy ? <LoaderCircle size={16} className="spin" /> : 'Save name'}</button></form></Modal>;
}

function DMNavigation({ conversation, participants, selected, onClick }: { conversation: Conversation; participants: Participant[]; selected: boolean; onClick: () => void }) {
  const names = conversation.participantIds.map(id => participants.find(p => p.id === id)?.name ?? 'Participant');
  return <button className={`conversation-link dm ${selected ? 'selected' : ''}`} onClick={onClick}><MessageCircle size={15} /><span>{names.join(' & ')}</span></button>;
}
function Welcome({ onCreate, disabled }: { onCreate: () => void; disabled: boolean }) {
  return <main className="welcome"><div className="welcome-top"><span className="eyebrow"><span className="tiny-star">✳</span> A LAB FOR COLLECTIVE INTELLIGENCE</span><span className="welcome-edition">MINDSPACE / 001</span></div><div className="welcome-hero"><div className="welcome-copy"><h1>Good ideas<br />have <em>company.</em></h1><p>Give a team of independent agents a shared challenge. Follow the conversation, peek into their process, and help them find their way.</p><button className="primary-button" onClick={onCreate} disabled={disabled}>Create an experiment <ArrowRight size={17} /></button><span className="welcome-footnote">3–5 agents · Persistent context · Human collaboration</span></div><div className="constellation" aria-hidden="true"><div className="orbit orbit-one" /><div className="orbit orbit-two" /><div className="orbit orbit-three" /><svg viewBox="0 0 400 400"><path d="M105 110L300 125L290 290L102 272Z M105 110L290 290 M300 125L102 272" stroke="currentColor" strokeWidth="1" strokeDasharray="3 6" fill="none" /></svg><div className="constellation-center"><Logo compact /><span>A SHARED SPACE</span></div><span className="orbit-agent one"><Bot size={26} /><span>Perspective</span></span><span className="orbit-agent two"><Compass size={26} /><span>Curiosity</span></span><span className="orbit-agent three"><Sparkles size={25} /><span>Discovery</span></span><span className="orbit-agent four"><Users size={25} /><span>You</span></span><i className="star one">+</i><i className="star two">+</i><i className="star three">+</i></div></div><div className="welcome-principles"><div><span>01</span><MessagesSquare size={21} /><h3>Conversation, with intent.</h3><p>Shared rounds give every agent a chance to speak, listen, or pass.</p></div><div><span>02</span><Eye size={21} /><h3>A window into the work.</h3><p>Follow tool calls and available reasoning summaries as they happen.</p></div><div><span>03</span><Workflow size={21} /><h3>Stay in the loop.</h3><p>Message the group or steer an individual agent through a direct conversation.</p></div></div></main>;
}
function RoundBar({ snapshot, busy, runtimeAvailable, onControl }: { snapshot: Snapshot; busy: boolean; runtimeAvailable: boolean; onControl: (action: Control) => Promise<void> }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  const { session } = snapshot;
  const round = snapshot.rounds.at(-1);
  const hasActiveAgent = snapshot.participants.some(participant => participant.kind === 'agent' && ['thinking', 'tool', 'queued'].includes(participant.status));
  const directWorkActive = session.status === 'idle' && hasActiveAgent;
  const running = session.status === 'running' || session.status === 'cooldown' || hasActiveAgent;
  const delay = session.nextRoundAt ? Math.max(0, Math.ceil((new Date(session.nextRoundAt).getTime() - now) / 1000)) : 0;
  return <section className="round-bar" aria-label="Round controls"><div className="round-summary"><span className={`round-symbol ${session.status}`}><Workflow size={17} /></span><div><strong>{session.roundNumber ? `Round ${String(session.roundNumber).padStart(2, '0')}` : 'Ready when you are'}<span className="round-divider">/</span><span className="round-state">{directWorkActive ? 'Direct conversations active' : session.status === 'cooldown' ? `Next in ${delay}s` : session.status === 'idle' ? 'Waiting for a new thought' : session.status === 'paused' ? 'Paused' : 'In progress'}</span></strong>{session.reason && !directWorkActive && <p title={session.reason}>{session.reason}</p>}</div></div><div className="round-opportunities" aria-label="Agent opportunities">{(round?.opportunities ?? snapshot.participants.filter(p => p.kind === 'agent').map(agent => ({ agentId: agent.id, status: 'pending' }))).map((opportunity, index) => { const agent = snapshot.participants.find(p => p.id === opportunity.agentId); return <div key={opportunity.agentId} className={`opportunity ${opportunity.status}`} title={`${agent?.name}: ${opportunity.status}`}><span>{opportunity.status === 'spoke' ? <Check size={11} /> : opportunity.status === 'running' ? <LoaderCircle size={11} className="spin" /> : index + 1}</span><span>{agent?.name}</span>{opportunity.status === 'passed' && <i>pass</i>}</div>; })}</div><div className="round-actions"><button className="quiet-button next-round" disabled={busy || !runtimeAvailable || session.status === 'running'} onClick={() => void onControl('next-round')} title="Run the next round now">Next round <ArrowRight size={14} /></button><button className={`session-control ${running ? 'pause' : ''}`} disabled={busy || (!running && !runtimeAvailable)} onClick={() => void onControl(running ? 'pause' : session.startedAt ? 'resume' : 'start')}>{busy ? <LoaderCircle size={14} className="spin" /> : running ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}{running ? 'Pause' : session.startedAt ? 'Resume' : 'Start session'}</button></div></section>;
}
function ChatLog({ messages, participants, ownId, task, recipientName, onInspect }: { messages: Message[]; participants: Participant[]; ownId?: string; task?: string; recipientName?: string; onInspect: (id: string) => void }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);
  useEffect(() => { if (atBottom.current && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; else if (messages.length) setShowJump(true); }, [messages.length]);
  return <div className="chat-log-wrap"><div className="chat-log" ref={scrollRef} onScroll={() => { const el = scrollRef.current; if (el) { atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100; if (atBottom.current) setShowJump(false); } }}>
    <div className="conversation-start"><span>{task ? 'A new space for thinking together' : 'A direct line'}</span></div>
    {task && <details className="task-brief" open={!messages.length}><summary><span><Compass size={16} /> The shared challenge</span><ChevronDown size={15} /></summary><p>{task}</p></details>}
    {!messages.length && <div className="chat-empty"><span><MessagesSquare size={24} strokeWidth={1.3} /></span><h3>{task ? 'Every collaboration starts somewhere.' : `Start a conversation${recipientName ? ` with ${recipientName}` : ''}.`}</h3><p>{task ? 'Add a thought below, or start the session to give each agent a chance to explore the challenge.' : 'Your messages are delivered directly. All human observers can follow along.'}</p></div>}
    {messages.map((message, index) => { const sender = participants.find(p => p.id === message.senderId); if (!sender) return null; const previous = messages[index - 1]; const grouped = previous?.senderId === sender.id && new Date(message.createdAt).getTime() - new Date(previous.createdAt).getTime() < 120000; const reply = message.replyTo ? messages.find(m => m.id === message.replyTo) : null; return <article className={`message ${grouped ? 'grouped' : ''} ${sender.kind}`} key={message.id}>{!grouped ? <button className="message-avatar" disabled={sender.kind !== 'agent'} aria-label={`Inspect ${sender.name}`} onClick={() => onInspect(sender.id)}><Avatar participant={sender} /></button> : <span className="message-avatar-spacer" />}<div className="message-content">{!grouped && <div className="message-meta"><button disabled={sender.kind !== 'agent'} onClick={() => onInspect(sender.id)} style={{ color: sender.kind === 'agent' ? sender.color : undefined }}>{sender.name}</button><span className="sender-kind">{sender.kind === 'agent' ? 'AGENT' : sender.id === ownId ? 'YOU' : 'HUMAN'}</span><time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time></div>}{reply && <div className="reply-preview"><MessageCircle size={12} /><span>{reply.body.slice(0, 160)}</span></div>}<div className="message-body">{message.body}</div></div></article>; })}
  </div>{showJump && <button className="jump-latest" onClick={() => { if (scrollRef.current) scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }); atBottom.current = true; setShowJump(false); }}>New messages <ArrowDown size={14} /></button>}</div>;
}
function Composer({ onSend, placeholder, label, footer, compact = false }: { onSend: (body: string, requestId: string) => Promise<void>; placeholder: string; label: string; footer?: string; compact?: boolean }) {
  const [body, setBody] = useState(''); const [sending, setSending] = useState(false); const [error, setError] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null); const requestRef = useRef<string | null>(null);
  async function submit(event?: FormEvent) { event?.preventDefault(); if (!body.trim() || sending) return; const value = body.trim(); setSending(true); setError(''); try { requestRef.current ??= crypto.randomUUID(); await onSend(value, requestRef.current); requestRef.current = null; setBody(''); if (ref.current) ref.current.style.height = ''; } catch (failure) { setError(errorText(failure)); } finally { setSending(false); ref.current?.focus(); } }
  return <form className={`composer ${compact ? 'compact' : ''}`} onSubmit={submit}><div className="composer-input"><textarea ref={ref} value={body} aria-label={label} placeholder={placeholder} rows={compact ? 2 : 2} maxLength={20000} disabled={sending} onChange={event => { setBody(event.target.value); requestRef.current = null; event.target.style.height = 'auto'; event.target.style.height = `${Math.min(event.target.scrollHeight, 200)}px`; }} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }} /><div className="composer-tools"><span>{compact ? <><MessageCircle size={12} /> Direct message</> : <><span className="composer-format">Aa</span><span className="composer-hint">Shift + Enter for a new line</span></>}</span><button className="send-button" type="submit" disabled={sending || !body.trim()} aria-label={label}>{sending ? <LoaderCircle size={16} className="spin" /> : <ArrowUp size={17} />}</button></div></div>{error && <p className="form-error" role="alert">{error}</p>}{footer && <p className="composer-footer"><Eye size={11} />{footer}</p>}</form>;
}
function AgentInspector({ agent, agents, activities, pending, uncertain, onSelect, onClose, onControl, busy, onSend, onOpenChat }: { agent: Participant; agents: Participant[]; activities: Activity[]; pending: number; uncertain: number; onSelect: (id: string) => void; onClose: () => void; onControl: (action: Control, id: string) => Promise<void>; busy: boolean; onSend: (body: string, requestId: string) => Promise<void>; onOpenChat: () => void }) {
  const [tab, setTab] = useState<'activity' | 'profile'>('activity');
  const feedRef = useRef<HTMLDivElement>(null); const atBottom = useRef(true);
  useEffect(() => { if (atBottom.current && feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight; }, [activities]);
  return <aside className="inspector"><div className="inspector-top"><span><Radio size={14} /> AGENT OBSERVATORY</span><button className="icon-button" aria-label="Close agent inspector" onClick={onClose}><X size={16} /></button></div><div className="agent-tabs" role="tablist" aria-label="Inspect an agent">{agents.map(a => <button role="tab" aria-selected={agent.id === a.id} className={agent.id === a.id ? 'active' : ''} key={a.id} onClick={() => onSelect(a.id)} style={{ '--tab-color': a.color } as React.CSSProperties}><i className={`presence ${a.status}`} />{a.name}</button>)}</div><div className="inspector-profile"><Avatar participant={agent} size="large" /><div><h2>{agent.name}</h2><Status status={agent.status} /></div><button className="icon-button agent-pause" title={agent.status === 'paused' ? 'Resume this agent' : 'Pause and interrupt this agent'} aria-label={agent.status === 'paused' ? `Resume ${agent.name}` : `Pause ${agent.name}`} onClick={() => void onControl(agent.status === 'paused' ? 'resume-agent' : 'pause-agent', agent.id)} disabled={busy}>{agent.status === 'paused' ? <Play size={15} /> : <Pause size={15} />}</button></div><div className="agent-model"><span>{agent.model}</span><span>{agent.effort} reasoning</span></div><div className="inspector-view-tabs"><button onClick={() => setTab('activity')} className={tab === 'activity' ? 'active' : ''}>Activity <span>{activities.length}</span></button><button onClick={() => setTab('profile')} className={tab === 'profile' ? 'active' : ''}>Configuration</button><span className="token-count" title="Reported tokens used">{formatNumber(agent.tokensUsed)} <span>tokens</span></span></div>
    {uncertain > 0 && <div className="delivery-warning" role="status"><Clock3 size={13} /><span>{uncertain} message{uncertain !== 1 ? 's' : ''} with uncertain processing. The agent may not have acted on them. Review the conversation before resending.</span></div>}<div className="activity-feed" ref={feedRef} onScroll={() => { const el = feedRef.current; if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 70; }}>{tab === 'profile' ? <div className="agent-configuration"><div className="eyebrow">PERSPECTIVE</div><p>{agent.instructions || 'No additional role instructions.'}</p><div className="eyebrow">AVAILABLE TOOLS</div><div className="tool-chip-list"><span><Hash size={12} /> Group messages</span><span><MessageCircle size={12} /> Direct messages</span><span><MessagesSquare size={12} /> Group history</span>{agent.webFetch && <span><Globe2 size={12} /> Web fetch</span>}</div><div className="eyebrow">PERSISTENT CONTEXT</div><p className="context-description">{agent.threadId ? 'Connected to a dedicated Codex thread. Context persists across rounds and direct conversations.' : 'A dedicated context will be created when this agent first runs.'}</p>{agent.threadId && <code className="thread-id">{agent.threadId}</code>}<p className="context-description">{pending} message{pending !== 1 ? 's' : ''} queued or needing review.</p></div> : !activities.length ? <div className="activity-empty"><span className="activity-empty-orbit"><Compass size={26} strokeWidth={1.2} /></span><h3>A little quiet, for now.</h3><p>{agent.name}’s progress, tool calls, and available reasoning summaries will appear here.</p><span className="empty-activity-line"><i /> Waiting for the first turn</span></div> : <div className="activity-timeline">{activities.map(activity => <ActivityItem key={activity.id} activity={activity} />)}</div>}</div>
    <div className="steer-area"><div className="steer-heading"><span>Give {agent.name} a nudge</span><button onClick={onOpenChat} title={`Open your conversation with ${agent.name}`} aria-label={`Open your conversation with ${agent.name}`}><ExternalLink size={13} /></button></div><Composer compact placeholder={`A thought for ${agent.name}…`} label={`Send a direct message to ${agent.name}`} onSend={onSend} /><p className="steer-note">Delivered through your direct conversation.</p></div>
  </aside>;
}
function ActivityItem({ activity }: { activity: Activity }) {
  const icon = activity.kind === 'tool' ? <Terminal size={13} /> : activity.kind === 'reasoning' ? <Sparkles size={13} /> : activity.kind === 'message' ? <MessageCircle size={13} /> : activity.kind === 'error' ? <X size={13} /> : <Circle size={11} />;
  const expandable = activity.kind === 'tool' || activity.kind === 'reasoning';
  const heading = <><span className={`activity-icon ${activity.kind}`}>{activity.status === 'inProgress' ? <LoaderCircle className="spin" size={13} /> : icon}</span><span className="activity-title">{activity.title || activity.kind}</span>{activity.status === 'interrupted' || activity.status === 'failed' ? <span className="activity-state">{activity.status}</span> : <time>{formatTime(activity.createdAt)}</time>}{expandable && <ChevronDown className="activity-chevron" size={12} />}</>;
  const content = <>{activity.text && <div className="activity-text">{activity.text}</div>}{activity.arguments !== undefined && <div className="activity-code"><span>ARGUMENTS</span><pre>{typeof activity.arguments === 'string' ? activity.arguments : JSON.stringify(activity.arguments, null, 2)}</pre></div>}{activity.result !== undefined && <div className="activity-code"><span>RESULT</span><pre>{typeof activity.result === 'string' ? activity.result : JSON.stringify(activity.result, null, 2)}</pre></div>}</>;
  return <div className={`activity-item ${activity.kind} ${activity.status}`}>{expandable ? <details><summary>{heading}</summary><div className="activity-detail">{content}{!activity.text && activity.arguments === undefined && activity.result === undefined && <span className="muted">Waiting for details…</span>}</div></details> : <><div className="activity-heading">{heading}</div><div className="activity-detail">{content}</div></>}</div>;
}

function Modal({ children, title, onClose, wide = false }: { children: ReactNode; title: string; onClose?: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null); const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = ref.current;
    const first = element?.querySelector<HTMLElement>('input,button,textarea,select'); first?.focus();
    function handle(event: KeyboardEvent) {
      if (event.key === 'Escape' && onClose) onClose();
      if (event.key !== 'Tab' || !element) return;
      const focusable = Array.from(element.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),summary,[tabindex="0"]')).filter(el => el.getClientRects().length > 0);
      const first = focusable[0]; const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
    document.addEventListener('keydown', handle); return () => { document.removeEventListener('keydown', handle); previous?.focus(); };
  }, []);
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose?.(); }}><div className={`modal ${wide ? 'wide' : ''}`} ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId}><div className="modal-header"><h2 id={titleId}>{title}</h2>{onClose && <button className="icon-button" aria-label="Close dialog" onClick={onClose}><X size={19} /></button>}</div>{children}</div></div>;
}
function IdentityDialog({ onSubmit }: { onSubmit: (name: string) => Promise<void> }) {
  const [name, setName] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  return <Modal title="Make yourself at home."><form className="identity-form" onSubmit={async event => { event.preventDefault(); if (!name.trim()) return; setBusy(true); setError(''); try { await onSubmit(name.trim()); } catch (failure) { setError(errorText(failure)); setBusy(false); } }}><div className="identity-intro"><span><Users size={25} /></span><p>You’re part of the conversation, too.<br />Choose the name your collaborators will see.</p></div><label>Your name<input autoComplete="nickname" maxLength={60} placeholder="e.g. Jamie" value={name} onChange={event => setName(event.target.value)} required /></label>{error && <p className="form-error" role="alert">{error}</p>}<button className="primary-button full-width" type="submit" disabled={busy || !name.trim()}>{busy ? <LoaderCircle size={16} className="spin" /> : <>Enter Mindspace <ArrowRight size={16} /></>}</button><p className="identity-note">Saved in this browser. Every human can observe all conversations.</p></form></Modal>;
}
function CreateDialog({ onClose, onSubmit, mode, getImportProgress }: { onClose: () => void; onSubmit: (input?: CreateSessionInput) => Promise<void>; mode?: string; getImportProgress: () => Promise<{ loaded: number; total: number }> }) {
  const [title, setTitle] = useState(''); const [task, setTask] = useState(''); const [agents, setAgents] = useState(suggestedAgents.slice(0, 3));
  const [settings, setSettings] = useState({ ...DEFAULT_SETTINGS }); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [preset, setPreset] = useState<'arxiv' | 'freeform'>('arxiv');
  const [imported, setImported] = useState(0);
  useEffect(() => {
    if (!busy || preset !== 'arxiv') return;
    let active = true;
    const poll = () => { void getImportProgress().then(value => { if (active) setImported(value.loaded); }).catch(() => {}); };
    poll(); const timer = setInterval(poll, 1500);
    return () => { active = false; clearInterval(timer); };
  }, [busy, preset, getImportProgress]);
  const choices = <div className="experiment-choices" aria-label="Experiment type"><button type="button" aria-pressed={preset === 'arxiv'} disabled={busy} onClick={() => { setPreset('arxiv'); setError(''); }}><Globe2 size={16} /> AI paper review</button><button type="button" aria-pressed={preset === 'freeform'} disabled={busy} onClick={() => { setPreset('freeform'); setError(''); }}><Compass size={16} /> Freeform</button></div>;
  if (preset === 'arxiv') return <Modal wide title="Put three minds to work." onClose={busy ? undefined : onClose}><div className="create-form">{choices}<div className="arxiv-preset"><span className="eyebrow">READY-TO-RUN EXPERIMENT</span><h3>2,000 AI papers.<br />One shared research workspace.</h3><p>A real list of arXiv titles and links. Fox, Horse and Pig each review a third, caching PDFs in the shared directory, reading the local text and saving their findings as they go.</p><div className="preset-roster">{suggestedAgents.slice(0, 3).map((agent, index) => <div key={agent.name}><Avatar participant={{ name: agent.name, kind: 'agent', color: agentColors[index] }} /><span><strong>{agent.name}</strong><small>Paper reviewer · {index === 2 ? '666' : '667'} papers</small></span></div>)}</div><p>The paper list, downloaded PDFs and extracted text stay in an ignored shared directory. Add up to two more agents with your own tasks after starting.</p><p>No run limits. Pause any time; reviews and shared files are saved as agents work.</p>{error && <p className="form-error" role="alert">{error}</p>}<button className="primary-button full-width" disabled={busy} onClick={async () => { setBusy(true); setError(''); setImported(0); try { await onSubmit(); } catch (failure) { setError(errorText(failure)); setBusy(false); } }}>{busy ? <><LoaderCircle size={16} className="spin" /> Collecting links… {formatNumber(imported)} / 2,000</> : <>Start AI paper review <ArrowRight size={16} /></>}</button><p className="preset-footnote">Collecting the list can take a minute or two. Agents start automatically once all 2,000 links are saved. PDFs are downloaded as agents work and reused locally.</p></div></div></Modal>;
  function editAgent(index: number, change: Partial<typeof suggestedAgents[number]>) { setAgents(previous => previous.map((agent, i) => i === index ? { ...agent, ...change } : agent)); }
  return <Modal wide title="Start with a shared challenge." onClose={busy ? undefined : onClose}><form className="create-form" onSubmit={async event => { event.preventDefault(); setBusy(true); setError(''); try { await onSubmit({ title: title.trim(), task: task.trim(), agents: agents.map(agent => ({ ...agent, name: agent.name.trim(), instructions: agent.instructions.trim() })), settings }); } catch (failure) { setError(errorText(failure)); setBusy(false); } }}>{choices}<p className="modal-description">Set the direction. Assemble a few different perspectives. See where they take it.</p><label>Experiment name<input placeholder="e.g. Mapping the research landscape" value={title} onChange={event => setTitle(event.target.value)} maxLength={120} required /></label><label><span className="field-heading">The shared challenge<button type="button" className="text-button" onClick={() => { setTitle('Mapping the research landscape'); setTask('Work together to design a useful taxonomy for AI research papers. Propose clear categories, debate ambiguous boundaries, and agree on a classification rubric. Use these fictional paper descriptions as test cases:\n\n1. A method for retrieving external documents to improve factual question answering.\n2. A benchmark measuring how groups of language model agents coordinate on shared tasks.\n3. A technique that reduces the memory needed to fine-tune large language models.\n\nDivide the work, compare your reasoning, and produce a concise shared taxonomy with the three examples classified.'); }}>Use an example <ArrowRight size={12} /></button></span><textarea placeholder="What should your agents explore together? Include context, materials, and what a useful result looks like." value={task} onChange={event => setTask(event.target.value)} rows={4} maxLength={30000} required /></label><div className="roster-heading"><div><h3>Assemble the minds</h3><p>Each agent gets its own role and persistent context.</p></div><span>{agents.length} / 5 agents</span></div><div className="setup-agents">{agents.map((agent, index) => <div className="setup-agent" key={index}><div className="setup-agent-top"><Avatar participant={{ name: agent.name, kind: 'agent', color: agentColors[index] }} /><input aria-label={`Agent ${index + 1} name`} value={agent.name} onChange={event => editAgent(index, { name: event.target.value })} maxLength={60} required /><span className="setup-model">Terra 5.6 <span>HIGH</span></span>{agents.length > 3 && <button type="button" className="icon-button" aria-label={`Remove ${agent.name}`} onClick={() => setAgents(previous => previous.filter((_, i) => i !== index))}><X size={15} /></button>}</div><textarea aria-label={`${agent.name || `Agent ${index + 1}`} instructions`} value={agent.instructions} onChange={event => editAgent(index, { instructions: event.target.value })} rows={2} maxLength={12000} placeholder="What perspective should this agent bring?" /><label className="checkbox-label"><input type="checkbox" checked={agent.webFetch} onChange={event => editAgent(index, { webFetch: event.target.checked })} /><Globe2 size={13} /> Allow public web fetch</label></div>)}</div>{agents.length < 5 && <button type="button" className="add-agent" onClick={() => setAgents(previous => [...previous, { ...(suggestedAgents.find(suggestion => !previous.some(agent => agent.name === suggestion.name)) ?? suggestedAgents[previous.length]) }])}><Plus size={15} /> Add another perspective</button>}<details className="session-options"><summary><span><Settings2 size={15} /> Round pacing</span><ChevronDown size={15} /></summary><p>Agents take turns in the group and can message one another between turns. An all-pass round lets the session rest.</p><div className="settings-fields"><label>Between rounds, seconds<input type="number" min="0" max="3600" value={settings.roundDelayMs / 1000} onChange={e => setSettings({ ...settings, roundDelayMs: Number(e.target.value) * 1000 })} required /></label></div></details>{error && <p className="form-error" role="alert">{error}</p>}<div className="create-footer"><span><Circle size={10} />{mode === 'simulation' ? 'Creates a simulation session' : 'Starts paused. You decide when to begin.'}</span><button className="primary-button" disabled={busy || !title.trim() || !task.trim() || agents.some(agent => !agent.name.trim())} type="submit">{busy ? <LoaderCircle size={16} className="spin" /> : <>Create experiment <ArrowRight size={16} /></>}</button></div></form></Modal>;
}
function SettingsDialog({ snapshot, onClose }: { snapshot: Snapshot; onClose: () => void }) {
  const { session } = snapshot; const { settings } = session;
  return <Modal title="Experiment settings" onClose={onClose}><div className="settings-dialog"><p className="modal-description">Pause or resume whenever you like. You can add agents with new tasks from the sidebar.</p><div className="settings-title">{session.title}<Status status={session.status} /></div><dl><div><dt>Runtime</dt><dd>{session.runtimeMode === 'simulation' ? 'Simulation (scripted)' : 'Codex App Server'}</dd></div><div><dt>Agent model</dt><dd>gpt-5.6-terra · high</dd></div><div><dt>Between rounds</dt><dd>{settings.roundDelayMs / 1000} seconds</dd></div><div><dt>Rounds started</dt><dd>{session.roundNumber}</dd></div><div><dt>Turns started</dt><dd>{session.turnCount}</dd></div><RunLimits settings={settings} /><div><dt>Created</dt><dd>{new Date(session.createdAt).toLocaleString()}</dd></div></dl><p className="settings-note"><Eye size={15} />All human participants can inspect every chat and agent activity stream.</p><button className="secondary-button full-width" onClick={onClose}>Back to the experiment</button></div></Modal>;
}

function AddAgentDialog({ onClose, onSubmit }: { onClose: () => void; onSubmit: (input: { name: string; instructions: string; webFetch: boolean }) => Promise<void> }) {
  const [name, setName] = useState(''); const [instructions, setInstructions] = useState(''); const [webFetch, setWebFetch] = useState(true);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  return <Modal title="Add a mind to the experiment." onClose={busy ? undefined : onClose}><form className="create-form" onSubmit={async event => { event.preventDefault(); setBusy(true); setError(''); try { await onSubmit({ name: name.trim(), instructions: instructions.trim(), webFetch }); } catch (failure) { setError(errorText(failure)); setBusy(false); } }}><p className="modal-description">Give this agent its own task. It joins the next round with access to the conversation, paper reviews and shared directory.</p><label>Name<input value={name} onChange={e => setName(e.target.value)} maxLength={80} required placeholder="e.g. Owl" /></label><label>Task<textarea value={instructions} onChange={e => setInstructions(e.target.value)} rows={5} maxLength={16000} required placeholder="e.g. Find recurring themes in the reviews and maintain a taxonomy in the shared directory." /></label><label className="checkbox-label"><input type="checkbox" checked={webFetch} onChange={e => setWebFetch(e.target.checked)} /> Allow public web fetch</label>{error && <p role="alert" className="form-error">{error}</p>}<div className="create-footer"><span>Terra 5.6 · High reasoning</span><button className="primary-button" disabled={busy || !name.trim() || !instructions.trim()}>{busy ? <LoaderCircle className="spin" size={16} /> : 'Add agent'}</button></div></form></Modal>;
}
function SharedFilesDialog({ onClose, load, fileUrl }: { onClose: () => void; load: (query?: string) => Promise<any>; fileUrl: string }) {
  type Listing = { directory: string; directories: string[]; files: Array<{ path: string; bytes: number }>; hasMore: boolean; nextOffset: number };
  const [listing, setListing] = useState<Listing>();
  const [folder, setFolder] = useState('');
  const [file, setFile] = useState<{ path: string; text: string; nextOffset: number; hasMore: boolean }>();
  const [error, setError] = useState(''); const [busy, setBusy] = useState(true);
  useEffect(() => { let active = true; void load().then(value => { if (active) setListing(value); }).catch(failure => { if (active) setError(errorText(failure)); }).finally(() => { if (active) setBusy(false); }); return () => { active = false; }; }, []);
  async function browse(directory: string, offset = 0) {
    setBusy(true); setError('');
    try {
      const query = new URLSearchParams({ offset: String(offset) });
      if (directory) query.set('directory', directory);
      const page: Listing = await load(`?${query}`);
      setListing(previous => offset && previous ? { ...page, files: [...new Map([...previous.files, ...page.files].map(item => [item.path, item])).values()] } : page);
      setFolder(directory);
      if (!offset) setFile(undefined);
    } catch (failure) { setError(errorText(failure)); } finally { setBusy(false); }
  }
  async function open(path: string, offset = 0) { setBusy(true); setError(''); try { setFile(await load(`?path=${encodeURIComponent(path)}&offset=${offset}`)); } catch (failure) { setError(errorText(failure)); } finally { setBusy(false); } }
  return <Modal wide title="Shared experiment files" onClose={onClose}><div className="create-form">
    <p className="modal-description">Every agent works in this directory. Files remain available after a restart.</p>
    {listing && <><code className="shared-directory">{listing.directory}{folder ? `/${folder}` : ''}</code>
      <nav className="shared-file-folders" aria-label="Workspace folders">
        {folder && <button className="secondary-button" disabled={busy} onClick={() => void browse(folder.split('/').slice(0, -1).join('/'))}>Up one folder</button>}
        {listing.directories.map(directory => <button className="secondary-button" key={directory} disabled={busy} onClick={() => void browse(directory)}>{directory}/</button>)}
        <button className="secondary-button" disabled={busy} onClick={() => void browse(folder)}>Refresh files</button>
      </nav>
      <div className="shared-file-list">{listing.files.map(item => item.path.endsWith('.pdf') ? <a className="secondary-button" key={item.path} href={`${fileUrl}?path=${encodeURIComponent(item.path)}`} target="_blank" rel="noreferrer">{item.path} <small>{formatNumber(item.bytes)} bytes</small></a> : <button className="secondary-button" key={item.path} disabled={busy} onClick={() => void open(item.path)}>{item.path} <small>{formatNumber(item.bytes)} bytes</small></button>)}</div>
      {listing.hasMore && <button className="secondary-button" disabled={busy} onClick={() => void browse(folder, listing.nextOffset)}>Load more files <ArrowDown size={12} /></button>}
      {!listing.files.length && <p>No files in this folder yet.</p>}
    </>}
    {busy && <p role="status">Loading…</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {file && <><h3>{file.path}</h3><pre className="shared-file-content">{file.text}</pre>{file.hasMore && <button className="secondary-button" disabled={busy} onClick={() => void open(file.path, file.nextOffset)}>Next page <ArrowRight size={12} /></button>}</>}
  </div></Modal>;
}
