
import { Link } from 'react-router';

import styles from './404.module.css'

function NotFound() {
    return (
        <div className={ styles.container }>
            <h2>Page not found</h2>
            <Link to="/">Go Home</Link>
        </div>
    );
}


export default NotFound;
