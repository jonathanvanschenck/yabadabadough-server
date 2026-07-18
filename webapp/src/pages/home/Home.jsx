
import { Link } from 'react-router';

import logo from '/svg/logo-badge.svg'
import styles from './Home.module.css'

const SECTIONS = [
    { to: "/funds", title: "Funds", description: "Balances and the fund hierarchy" },
    { to: "/transactions", title: "Transactions", description: "Money moving between funds" },
    { to: "/allocations", title: "Allocations", description: "Monthly budgets and saving" },
    { to: "/statements", title: "Statements", description: "Bank imports and reconciliation" },
];

function Home() {
    return (
        <div className={ styles.container }>
            <img className={ styles.logo } src={ logo } alt="" />
            <h1 className={ styles.title }>Yabadaba Dough</h1>
            <p className={ styles.tagline }>Personal finance, one fund at a time.</p>
            <div className={ styles.sections }>
                { SECTIONS.map(({ to, title, description }) => (
                    <Link key={ to } to={ to } className={ styles.sectionLink }>
                        <span className={ styles.sectionTitle }>{ title }</span>
                        <span className={ styles.sectionDescription }>{ description }</span>
                    </Link>
                )) }
            </div>
        </div>
    );
}

export default Home;
