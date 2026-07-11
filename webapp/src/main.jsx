import {
    createBrowserRouter,
    RouterProvider,
} from "react-router";

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import AppLayout from './AppLayout.jsx'


import NotFound from './pages/404/404.jsx'
import Funds from './pages/funds/Funds.jsx'
import Fund from './pages/fund/Fund.jsx'
import Transactions from './pages/transactions/Transactions.jsx'
import Statements from './pages/statements/Statements.jsx'

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
            children: [
                { index: true, Component: Home },
                { path: "funds", Component: Funds },
                { path: "fund/:id", Component: Fund },
                { path: "transactions", Component: Transactions },
                { path: "statements", Component: Statements },
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
