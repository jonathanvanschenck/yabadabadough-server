
import { useState, useEffect } from 'react';
import styles from './LoadingPlaceholder.module.css'

export default function LoadingPlaceholder({ description="", animateDelay=0 }) {
    const [isAnimated, setIsAnimated] = useState(animateDelay === 0);

    useEffect(() => {
        if (animateDelay > 0) {
            const timer = setTimeout(() => {
                setIsAnimated(true);
            }, animateDelay);

            return () => clearTimeout(timer);
        }
    }, [animateDelay]);

    return (
        <div className={ styles.container }>
            <div  className={ styles.innerContainer }>
                <h3 className={ styles.loadingText }>Loading ...</h3>
                <div className={ styles.spinnerContainer }>
                    <div
                        className={ `${styles.spinner} ${isAnimated ? styles.animated : ''}` }
                        role="status"
                    />
                </div>
                { description && <p className={ styles.descriptionText }>{ description }</p> }
            </div>
        </div>
    );
}

