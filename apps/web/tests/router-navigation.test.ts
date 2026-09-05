// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { navigate } from '../src/router';

describe('navigate', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/?preview=1#foldy');
  });

  it('preserves the current query and hash on conversation-file navigation', () => {
    const onPopState = vi.fn();
    window.addEventListener('popstate', onPopState, { once: true });

    navigate({
      kind: 'project',
      projectId: 'project-1',
      conversationId: 'conversation-1',
      fileName: 'index.html',
    });

    expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe(
      '/projects/project-1/conversations/conversation-1/files/index.html?preview=1#foldy',
    );
    expect(onPopState).toHaveBeenCalledOnce();
  });
});
