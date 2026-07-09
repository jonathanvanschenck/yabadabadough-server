
import styles from './Spinner.module.css';

function Spinner({ marginLeft, marginTop, marginRight, size="0.5rem" }) {
    const style = {
        "margin-left": marginLeft,
        "margin-right": marginRight,
        "margin-top": marginTop,
        width: size,
        height: size
    };

    return (
        <div className={`${styles.spinner} ${styles.animated}`} style={ style } role="status">
            <span className={styles.visuallyHidden}>Loading...</span>
        </div>
    );
}

export default Spinner;
