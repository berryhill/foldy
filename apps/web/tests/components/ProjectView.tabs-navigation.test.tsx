// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect, useState, type ComponentProps, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProjectView } from '../../src/components/ProjectView';
import { navigate } from '../../src/router';
import type {
  AgentInfo,
  AppConfig,
  Conversation,
  DesignSystemSummary,
  Project,
  SkillSummary,
} from '../../src/types';
import {
  createConversation,
  listConversations,
  listMessages,
  loadTabs,
} from '../../src/state/projects';
import { fetchPreviewComments } from '../../src/providers/registry';

vi.mock('../../src/i18n', () => ({
  useT: () => (key: string) => key,
}));

vi.mock('../../src/router', () => ({
  navigate: vi.fn(),
}));

vi.mock('../../src/providers/anthropic', () => ({
  streamMessage: vi.fn(),
}));

vi.mock('../../src/providers/daemon', () => ({
  fetchChatRunStatus: vi.fn(),
  listActiveChatRuns: vi.fn().mockResolvedValue([]),
  reattachDaemonRun: vi.fn(),
  streamViaDaemon: vi.fn(),
}));

vi.mock('../../src/providers/project-events', () => ({
  useProjectFileEvents: vi.fn(),
}));

vi.mock('../../src/providers/registry', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/registry')>(
    '../../src/providers/registry',
  );
  return {
    ...actual,
    deletePreviewComment: vi.fn(),
    fetchDesignSystem: vi.fn(),
    fetchLiveArtifacts: vi.fn().mockResolvedValue([]),
    fetchPreviewComments: vi.fn(),
    fetchProjectFiles: vi.fn().mockResolvedValue([]),
    fetchSkill: vi.fn(),
    getTemplate: vi.fn(),
    patchPreviewCommentStatus: vi.fn(),
    upsertPreviewComment: vi.fn(),
    writeProjectTextFile: vi.fn(),
  };
});

vi.mock('../../src/state/projects', async () => {
  const actual = await vi.importActual<typeof import('../../src/state/projects')>(
    '../../src/state/projects',
  );
  return {
    ...actual,
    createConversation: vi.fn(),
    listConversations: vi.fn(),
    listMessages: vi.fn(),
    loadTabs: vi.fn(),
    patchConversation: vi.fn(),
    patchProject: vi.fn(),
    saveMessage: vi.fn(),
    saveTabs: vi.fn(),
  };
});

vi.mock('../../src/components/AppChromeHeader', () => ({
  AppChromeHeader: ({ children }: { children: ReactNode }) => (
    <header>{children}</header>
  ),
}));

vi.mock('../../src/components/AvatarMenu', () => ({
  AvatarMenu: () => null,
}));

vi.mock('../../src/components/FileWorkspace', () => ({
  FileWorkspace: ({ openRequest, tabsState, onTabsStateChange }: ComponentProps<typeof import('../../src/components/FileWorkspace').FileWorkspace>) => {
    const [activeTab, setActiveTab] = useState(tabsState.active);
    useEffect(() => { setActiveTab(tabsState.active); }, [tabsState.active]);
    useEffect(() => {
      if (activeTab && !tabsState.tabs.includes(activeTab)) {
        const active = tabsState.tabs.at(-1) ?? null;
        setActiveTab(active);
        onTabsStateChange({ tabs: tabsState.tabs, active });
      }
    }, [tabsState.tabs, activeTab]);
    useEffect(() => {
      if (!openRequest) return;
      const name = openRequest.name;
      onTabsStateChange({
        tabs: tabsState.tabs.includes(name) ? tabsState.tabs : [...tabsState.tabs, name],
        active: name,
      });
      setActiveTab(name);
    }, [openRequest]);
    return (
      <div data-testid="file-workspace">
        <output data-testid="tabs-state">{JSON.stringify(tabsState)}</output>
        <output data-testid="active-tab">{activeTab}</output>
        <button onClick={() => setActiveTab(null)}>Design files</button>
        <button onClick={() => onTabsStateChange({ tabs: [], active: null })}>Close tabs</button>
      </div>
    );
  },
}));

vi.mock('../../src/components/Loading', () => ({
  CenteredLoader: () => <div data-testid="loader" />,
}));

vi.mock('../../src/components/ChatPane', () => ({
  ChatPane: () => <div data-testid="chat-pane" />,
}));

const mockedListConversations = vi.mocked(listConversations);
const mockedCreateConversation = vi.mocked(createConversation);
const mockedListMessages = vi.mocked(listMessages);
const mockedLoadTabs = vi.mocked(loadTabs);
const mockedFetchPreviewComments = vi.mocked(fetchPreviewComments);
const mockedNavigate = vi.mocked(navigate);

const config: AppConfig = {
  mode: 'api',
  apiKey: '',
  baseUrl: '',
  model: '',
  agentId: null,
  skillId: null,
  designSystemId: null,
};

const project: Project = {
  id: 'project-1',
  name: 'Project 1',
  skillId: null,
  designSystemId: null,
  createdAt: 1,
  updatedAt: 1,
};

const conversation: Conversation = {
  id: 'conv-1',
  projectId: project.id,
  title: null,
  createdAt: 1,
  updatedAt: 1,
};

function projectView(overrides: Partial<ComponentProps<typeof ProjectView>> = {}) {
  return (
    <ProjectView
      project={project}
      routeFileName={null}
      config={config}
      agents={[] as AgentInfo[]}
      skills={[] as SkillSummary[]}
      designTemplates={[] as SkillSummary[]}
      designSystems={[] as DesignSystemSummary[]}
      daemonLive
      onModeChange={vi.fn()}
      onAgentChange={vi.fn()}
      onAgentModelChange={vi.fn()}
      onRefreshAgents={vi.fn()}
      onOpenSettings={vi.fn()}
      onBack={vi.fn()}
      onClearPendingPrompt={vi.fn()}
      onTouchProject={vi.fn()}
      onProjectChange={vi.fn()}
      onProjectsRefresh={vi.fn()}
      {...overrides}
    />
  );
}

function renderProjectView(overrides: Partial<ComponentProps<typeof ProjectView>> = {}) {
  return render(projectView(overrides));
}

describe('ProjectView tab URL hydration', () => {
  beforeEach(() => {
    mockedListConversations.mockResolvedValue([conversation]);
    mockedCreateConversation.mockResolvedValue(conversation);
    mockedListMessages.mockResolvedValue([]);
    mockedLoadTabs.mockResolvedValue({ tabs: ['index.html'], active: 'index.html' });
    mockedFetchPreviewComments.mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('preserves a deep-linked file when saved tabs hydrate late', async () => {
    let resolveTabs!: (state: Awaited<ReturnType<typeof loadTabs>>) => void;
    mockedLoadTabs.mockReturnValue(new Promise((resolve) => { resolveTabs = resolve; }));
    renderProjectView({ routeFileName: 'requested.html' });
    await waitFor(() => expect(mockedListMessages).toHaveBeenCalled());

    await act(async () => {
      resolveTabs({ tabs: ['index.html'], active: 'index.html' });
    });

    await waitFor(() => expect(JSON.parse(screen.getByTestId('tabs-state').textContent!)).toEqual({
      tabs: ['index.html', 'requested.html'], active: 'requested.html',
    }));
    expect(mockedNavigate.mock.calls.every(([route]) => route.kind === 'project' && route.fileName === 'requested.html')).toBe(true);

    // Design Files is a local workspace view, not a persisted tab mutation.
    fireEvent.click(screen.getByText('Design files'));
    expect(screen.getByTestId('active-tab').textContent).toBe('');
    expect(JSON.parse(screen.getByTestId('tabs-state').textContent!).active).toBe('requested.html');
    // Closing tabs does change persistence and must be allowed to clear the URL.
    fireEvent.click(screen.getByText('Close tabs'));
    await waitFor(() => expect(mockedNavigate).toHaveBeenLastCalledWith(
      { kind: 'project', projectId: project.id, conversationId: 'conv-1', fileName: null },
      { replace: true },
    ));
  });

  it('focuses a hydrated uploaded-file deep link and reopens it from the local Design Files view', async () => {
    let resolveTabs!: (state: Awaited<ReturnType<typeof loadTabs>>) => void;
    mockedLoadTabs.mockReturnValue(new Promise((resolve) => { resolveTabs = resolve; }));
    const fileName = 'uploaded-reference.png';
    const view = renderProjectView({ routeFileName: fileName });
    await act(async () => { resolveTabs({ tabs: [fileName], active: fileName }); });
    await waitFor(() => expect(screen.getByTestId('active-tab').textContent).toBe(fileName));

    fireEvent.click(screen.getByText('Design files'));
    expect(screen.getByTestId('active-tab').textContent).toBe('');
    expect(JSON.parse(screen.getByTestId('tabs-state').textContent!).active).toBe(fileName);

    // A new route request must focus the local view even though persisted
    // active already equals the requested file (not an acknowledgement).
    view.rerender(projectView({ routeFileName: null }));
    view.rerender(projectView({ routeFileName: fileName }));
    await waitFor(() => expect(screen.getByTestId('active-tab').textContent).toBe(fileName));
    expect(JSON.parse(screen.getByTestId('tabs-state').textContent!)).toEqual({
      tabs: [fileName], active: fileName,
    });
  });

  it('uses the latest route while hydration is pending and follows later route changes', async () => {
    let resolveTabs!: (state: Awaited<ReturnType<typeof loadTabs>>) => void;
    mockedLoadTabs.mockReturnValue(new Promise((resolve) => { resolveTabs = resolve; }));
    const view = renderProjectView({ routeFileName: 'first.html' });
    view.rerender(projectView({ routeFileName: 'second.html' }));
    await act(async () => { resolveTabs({ tabs: [], active: null }); });
    await waitFor(() => expect(JSON.parse(screen.getByTestId('tabs-state').textContent!)).toEqual({
      tabs: ['second.html'], active: 'second.html',
    }));
    expect(mockedNavigate.mock.calls.every(([route]) => route.kind === 'project' && route.fileName === 'second.html')).toBe(true);

    view.rerender(projectView({ routeFileName: 'third.html' }));
    await waitFor(() => expect(JSON.parse(screen.getByTestId('tabs-state').textContent!)).toEqual({
      tabs: ['second.html', 'third.html'], active: 'third.html',
    }));
  });

  it('reopens the same route file after switching projects and ignores stale hydration', async () => {
    let resolveOldTabs!: (state: Awaited<ReturnType<typeof loadTabs>>) => void;
    mockedLoadTabs.mockReturnValueOnce(new Promise((resolve) => { resolveOldTabs = resolve; }));
    const view = renderProjectView({ routeFileName: 'requested.html' });
    const nextProject = { ...project, id: 'project-2' };
    view.rerender(projectView({ project: nextProject, routeFileName: 'requested.html' }));
    await waitFor(() => expect(JSON.parse(screen.getByTestId('tabs-state').textContent!)).toEqual({
      tabs: ['index.html', 'requested.html'], active: 'requested.html',
    }));
    await act(async () => { resolveOldTabs({ tabs: ['stale.html'], active: 'stale.html' }); });
    expect(JSON.parse(screen.getByTestId('tabs-state').textContent!)).toEqual({
      tabs: ['index.html', 'requested.html'], active: 'requested.html',
    });
    expect(mockedNavigate).toHaveBeenLastCalledWith(
      { kind: 'project', projectId: nextProject.id, conversationId: 'conv-1', fileName: 'requested.html' },
      { replace: true },
    );
  });

  it('syncs a persisted active tab to the URL before the file list has hydrated', async () => {
    renderProjectView();

    await waitFor(() => {
      expect(mockedNavigate).toHaveBeenCalledWith(
        // The active conversation id is threaded into the URL alongside
        // the active tab so a reload / share preserves the conversation
        // segment of `/projects/:id/conversations/:cid/files/...`
        // (PerishCode + Codex P1 on PR #1508).
        {
          kind: 'project',
          projectId: project.id,
          conversationId: 'conv-1',
          fileName: 'index.html',
        },
        { replace: true },
      );
    });
  });

  it('re-pushes /conversations/:cid when activeConversationId hydrates after the active tab has already synced (lefarcen P1 on PR #1508)', async () => {
    // Race shape: `loadTabs` resolves and sets the active tab BEFORE
    // `listConversations` resolves and sets `activeConversationId`.
    // The first navigate fires with `conversationId: null` because
    // the conversation hasn't loaded yet; the second navigate must
    // fire with `conversationId: 'conv-1'` even though the active
    // tab is identical. A ref guard that keys only on the file
    // target skips the second call and the URL never gains the
    // `/conversations/:cid` segment. The composite-key guard
    // (`${activeConversationId}:${target}`) catches it.
    let resolveConversations: (value: Conversation[]) => void = () => {};
    const conversationsPromise = new Promise<Conversation[]>((resolve) => {
      resolveConversations = resolve;
    });
    mockedListConversations.mockReturnValue(conversationsPromise);
    mockedLoadTabs.mockResolvedValue({ tabs: ['index.html'], active: 'index.html' });

    renderProjectView();

    // First navigate: active tab synced, conversation still loading.
    await waitFor(() => {
      expect(mockedNavigate).toHaveBeenCalledWith(
        {
          kind: 'project',
          projectId: project.id,
          conversationId: null,
          fileName: 'index.html',
        },
        { replace: true },
      );
    });

    // Now resolve the conversation list. The active tab is unchanged
    // but `activeConversationId` flips from `null` to `'conv-1'`, so
    // a second navigate must fire.
    resolveConversations([conversation]);

    await waitFor(() => {
      expect(mockedNavigate).toHaveBeenCalledWith(
        {
          kind: 'project',
          projectId: project.id,
          conversationId: 'conv-1',
          fileName: 'index.html',
        },
        { replace: true },
      );
    });
  });
});
