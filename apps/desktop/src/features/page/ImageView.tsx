import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { assetUrl } from '../../ipc';
import { nameOf } from '../../stores/tree';
import { revealKey } from '../explorer/reveal';
import { openImage, revealImage, useCanReveal } from '../preview/ImageMenu';
import { BackArrow } from './BackArrow';
import { Breadcrumb } from './Breadcrumb';
import { PageTitle } from './PageTitle';
import styles from './PageView.module.css';

/** An image opened from the files (0.1.2): its name and where it is, its size
 *  in pixels and the ways to open it elsewhere, then the image, fitted to the
 *  window. Keyed by path, so another image starts unmeasured. */
export function ImageView({ path }: { path: string }) {
  const { t } = useTranslation();
  const image = { path, external: false };
  const canReveal = useCanReveal(image);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [broken, setBroken] = useState(false);
  return (
    <section className={styles.page} aria-label={t('page.region')}>
      <div data-band="plain" className={styles.band}>
        <div className={styles.bandRows}>
          <div className={styles.heading}>
            <PageTitle path={path} />
          </div>
          <div className={styles.bar}>
            <div className={`${styles.where} ${styles.pill}`}>
              <BackArrow />
              <Breadcrumb path={path} />
            </div>
            <div className={styles.controls}>
              {size && (
                <span className={`${styles.count} ${styles.pill}`}>{t('image.size', size)}</span>
              )}
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => openImage(image)}
              >
                {t('page.openDefault')}
              </button>
              {canReveal && (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => revealImage(image)}
                >
                  {t(revealKey())}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
      <div className={styles.imageStage}>
        {broken ? (
          <p className={styles.notice}>{t('image.broken')}</p>
        ) : (
          <img
            data-image-view=""
            src={assetUrl(path)}
            alt={nameOf(path)}
            onLoad={(e) =>
              setSize({
                width: e.currentTarget.naturalWidth,
                height: e.currentTarget.naturalHeight,
              })
            }
            onError={() => setBroken(true)}
          />
        )}
      </div>
    </section>
  );
}
