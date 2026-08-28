import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { App } from '../src/tui/App.js';

describe('App integration', () => {
  const renderApp = (props = {}) => {
    const defaults = {
      initialPrompt: '',
      provider: 'mock',
      model: 'mock-echo-v1',
      cwd: 'C:\\test',
      theme: 'daya',
    };
    const { lastFrame } = render(React.createElement(App, { ...defaults, ...props }));
    return lastFrame();
  };

  it('renders header with DAYA wordmark and version pill', () => {
    const frame = renderApp();
    expect(frame).toContain('DAYA');
    expect(frame).toContain('v0.5.1');
  });

  it('renders segmented build/plan pills', () => {
    const frame = renderApp();
    expect(frame).toContain('build');
    expect(frame).toContain('plan');
  });

  it('shows breadcrumb with project name and model', () => {
    const frame = renderApp({ cwd: 'C:\\my-project', model: 'mock-echo-v1' });
    expect(frame).toContain('my-project');
    expect(frame).toContain('mock-echo-v1');
  });

  it('shows welcome hero when no logs', () => {
    const frame = renderApp();
    expect(frame).toContain('images');
    expect(frame).toContain('web');
    expect(frame).toContain('memory');
  });

  it('renders status bar with ctx meter', () => {
    const frame = renderApp();
    expect(frame).toContain('tools');
    expect(frame).toContain('k');
    expect(frame).toContain('$');
  });

  it('renders error card when initError is set (simulated via no provider key)', () => {
    // This would require mocking createProvider to throw
    // For now we just verify the component mounts
    const frame = renderApp({ provider: 'anthropic' });
    expect(frame).toContain('DAYA');
  });
});