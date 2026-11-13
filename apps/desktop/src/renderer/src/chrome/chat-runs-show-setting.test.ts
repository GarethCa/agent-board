import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { restoreViewSettings } from '../board/view-settings';
import { ChatRunsShowSetting } from './BoardViewSettings';

/** The option the setting shows as picked. */
function picked(): string | undefined {
  const html = renderToStaticMarkup(createElement(ChatRunsShowSetting));
  return /<button[^>]*aria-pressed="true"[^>]*>(.*?)<\/button>/.exec(html)?.[1]?.replace(/<[^>]*>/g, '');
}

describe('the Expand all and Collapse all show setting', () => {
  afterEach(() => restoreViewSettings({ chatRunsShow: 'always' }));

  it('picks Always by default', () => {
    expect(picked()).toBe('Always');
  });

  it('picks On hover once saved so', () => {
    restoreViewSettings({ chatRunsShow: 'hover' });
    expect(picked()).toBe('On hover');
  });
});
