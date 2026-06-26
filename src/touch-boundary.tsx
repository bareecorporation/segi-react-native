import { Component, createElement, type ReactNode } from 'react';
import { addSegiBreadcrumb } from './scope';

export interface SegiTouchEventBoundaryProps {
  children: ReactNode;
  /** Min ms between recorded taps (debounce). Default `300`. */
  throttleMs?: number;
}

interface TouchTarget {
  _debugOwner?: { elementType?: { displayName?: string; name?: string } };
  memoizedProps?: { accessibilityLabel?: string; testID?: string };
}

/**
 * Wrap your app to record a `ui.tap` breadcrumb on each touch (Sentry's
 * `TouchEventBoundary` parity). Uses the responder system so it never blocks touches.
 *
 * ```tsx
 * <SegiTouchEventBoundary>
 *   <App />
 * </SegiTouchEventBoundary>
 * ```
 */
export class SegiTouchEventBoundary extends Component<SegiTouchEventBoundaryProps> {
  private lastAt = 0;

  private onTouchStart = (e: {
    nativeEvent?: { pageX?: number; pageY?: number };
    _targetInst?: TouchTarget;
    target?: TouchTarget;
  }): void => {
    const throttle = this.props.throttleMs ?? 300;
    const now = Date.now();
    if (now - this.lastAt < throttle) return;
    this.lastAt = now;
    try {
      const label = resolveLabel(e?._targetInst ?? e?.target);
      addSegiBreadcrumb({
        type: 'ui',
        category: 'ui.tap',
        message: label ?? 'tap',
        data: {
          x: e?.nativeEvent?.pageX,
          y: e?.nativeEvent?.pageY,
        },
      });
    } catch {
      // never break touch handling
    }
  };

  render(): ReactNode {
    // A non-visual wrapper that observes touches in the capture phase without
    // claiming the responder (returns false), so child handlers run normally.
    return createElement(
      'View' as never,
      {
        style: { flex: 1 },
        onStartShouldSetResponderCapture: () => {
          // side-effect only; do not become responder
          return false;
        },
        onTouchStart: this.onTouchStart,
      },
      this.props.children,
    );
  }
}

function resolveLabel(target: TouchTarget | undefined): string | undefined {
  if (!target) return undefined;
  const props = target.memoizedProps;
  if (props?.accessibilityLabel) return props.accessibilityLabel;
  if (props?.testID) return props.testID;
  const owner = target._debugOwner?.elementType;
  return owner?.displayName ?? owner?.name;
}
