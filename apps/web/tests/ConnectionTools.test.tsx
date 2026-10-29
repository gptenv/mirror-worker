import './dom-setup.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import { ConnectionTools } from '../src/ConnectionTools.js';

test.describe('web / connection diagnostics credentials', () => {
  test.afterEach(() => { test.mock.restoreAll(); cleanup(); localStorage.clear(); });
  test('model discovery saves rotated credentials and informs the app', async () => {
    localStorage.setItem('mirror_access_token', 'old-access');
    const calls: string[] = [];
    test.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
      const url = String(input); calls.push(url);
      return url.includes('/api/diagnostics') ? Response.json({ ok: true }) : Response.json({ data: [{ id: 'model' }] }, { headers: { 'x-mirror-access-token': 'new-access', 'x-mirror-session-token': 'new-session' } });
    });
    const rotations: string[] = [];
    render(<ConnectionTools domain="https://mirror.example" apiKey="fixture" generationSucceeded={false} onSessionToken={token => rotations.push(token)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    await screen.findByText(/Model discovery passed/);
    assert.equal(localStorage.getItem('mirror_access_token'), 'new-access');
    assert.equal(localStorage.getItem('mirror_session_token'), 'new-session');
    assert.deepEqual(rotations, ['new-access']);
    assert.equal(calls.length, 2);
  });
  test('access rotation preserves the prior bearer as a fallback session', async () => {
    localStorage.setItem('mirror_access_token', 'old-session');
    test.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => String(input).includes('/api/diagnostics') ? Response.json({}) : Response.json({ data: [] }, { headers: { 'x-mirror-access-token': 'new-access' } }));
    render(<ConnectionTools domain="https://mirror.example" apiKey="" generationSucceeded={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    await screen.findByText(/Model discovery passed/);
    assert.equal(localStorage.getItem('mirror_access_token'), 'new-access');
    assert.equal(localStorage.getItem('mirror_session_token'), 'old-session');
  });
});
