import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import styles from './Preview.module.css';

interface Props {
  /** A new key (the text or page changed) clears the error and tries again. */
  resetKey: string;
  children: ReactNode;
}

function Fallback() {
  const { t } = useTranslation();
  return (
    <p role="alert" className={styles.renderFailed}>
      {t('preview.renderFailed')}
    </p>
  );
}

/** Keeps a render bug in the rendered pane (or an embed) inside it (I4):
 *  without a boundary React 19 unmounts the whole app and the window goes blank. */
interface State {
  failed: boolean;
  key: string;
}

export class RenderBoundary extends Component<Props, State> {
  state: State = { failed: false, key: this.props.resetKey };

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey === state.key ? null : { failed: false, key: props.resetKey };
  }

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('Rendered pane failed', error, info.componentStack);
  }

  render() {
    return this.state.failed ? <Fallback /> : this.props.children;
  }
}
