import { icons } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import { PAGE_ICONS } from '@agent-board/daemon/protocol';
import { PAGE_ICON_COMPONENTS } from './page-icons';

/** lucide's kebab-case name as its React component's: `flask-conical` is `FlaskConical`. */
const componentName = (name: string) => name.replace(/(^|-)([a-z0-9])/g, (_, _dash: string, letter: string) => letter.toUpperCase());

describe('the icons an agent may pick for its page', () => {
  it('are each an icon lucide draws, drawn by its own component', () => {
    expect(PAGE_ICONS.filter((name) => !(componentName(name) in icons))).toEqual([]);
    expect(PAGE_ICONS.filter((name) => PAGE_ICON_COMPONENTS[name] !== icons[componentName(name) as keyof typeof icons])).toEqual([]);
  });
});
