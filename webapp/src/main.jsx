import {
    createBrowserRouter,
    RouterProvider,
} from "react-router";

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import AppLayout from './AppLayout.jsx'


import NotFound from './pages/404/404.jsx'
import RouteError from './pages/error/RouteError.jsx'
import Funds from './pages/funds/Funds.jsx'
import Fund from './pages/fund/Fund.jsx'
import Transactions from './pages/transactions/Transactions.jsx'
import TransactionGroup from './pages/transaction_group/TransactionGroup.jsx'
import Allocations from './pages/allocations/Allocations.jsx'
import Statements from './pages/statements/Statements.jsx'
import Users from './pages/users/Users.jsx'
import User from './pages/user/User.jsx'

function Home() {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        height: '100vh',          // Full viewport height – this is the key!
        width: '100%',            // Full width
        background: 'var(--bg-primary-color)', // deepest plane, behind Pong
      }}
    >
      <div
        style={{
          position: 'relative',
          width: '80%',             // Adjust this (60–90%) to control game size
          maxWidth: '800px',        // Prevents it from getting huge on wide screens
          height: 0,
          overflow: 'hidden',
          paddingBottom: '56.25%',  // Keeps 16:9 aspect ratio
        }}
      >
          TODO
      </div>
    </div>
  );
}

const router = createBrowserRouter(
    [
        {
            path: "/",
            Component: AppLayout,
            ErrorBoundary: RouteError,
            children: [
                { index: true, Component: Home },
                { path: "funds", Component: Funds },
                { path: "fund/:id", Component: Fund },
                { path: "transactions", Component: Transactions },
                { path: "transaction-group/:id", Component: TransactionGroup },
                { path: "allocations", Component: Allocations },
                { path: "statements", Component: Statements },
                { path: "users", Component: Users },
                { path: "user/:id", Component: User },
                { path: "*", Component: NotFound  }
            ]
        }
    ],
    {
        /* opts */
    }
);

createRoot(document.getElementById('root')).render(
<StrictMode>
    <RouterProvider router={ router } />
</StrictMode>
)
