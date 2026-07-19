
import { Link } from 'react-router';

import { useAuth } from '../../contexts/AuthContext.jsx'

import logo from '/svg/logo-badge.svg'
import styles from './Home.module.css'

const SECTIONS = [
    { to: "/funds", title: "Funds", description: "The fund hierarchy and its settings" },
    { to: "/balances", title: "Balances", description: "What every fund holds, on any date" },
    { to: "/transactions", title: "Transactions", description: "Money moving between funds" },
    { to: "/allocations", title: "Allocations", description: "Monthly budgets and saving" },
    { to: "/statements", title: "Statements", description: "Bank imports and reconciliation" },
];

function Home() {
    const auth = useAuth();

    // Last, and only when there is an account to speak of: with
    // YDD_DISABLE_AUTH the server hands out no user id, so the link would
    // point nowhere.
    const sections = ( auth.disableAuth || auth.userId == null )
        ? SECTIONS
        : [ ...SECTIONS, {
            to: `/user/${auth.userId}`,
            title: "My account",
            description: "Password, sessions, and API keys",
        } ];

    return (
        <div className={ styles.container }>
            <img className={ styles.logo } src={ logo } alt="" />
            <h1 className={ styles.title }>Yabadaba Dough</h1>
            <p className={ styles.tagline }>Personal finance, one fund at a time.</p>
            <div className={ styles.sections }>
                { sections.map(({ to, title, description }) => (
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
