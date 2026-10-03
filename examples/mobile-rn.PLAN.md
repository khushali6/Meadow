---
project: expense-tracker-app
goal: A cross-platform React Native expense tracking app with offline-first SQLite storage, categories, monthly budget limits, and a weekly summary screen
stack: [react-native, expo, typescript, jest]
phases:
  - id: scaffold
    name: Project scaffold
    tasks:
      - Expo SDK 51 project with TypeScript template; enable strict mode in tsconfig
      - Expo Router v3 for file-based navigation; tabs layout with Home, Add, History, Settings
      - expo-sqlite for local storage; database initialised on first launch with the schema
      - Schema migration helper that applies version-stamped migrations without data loss
      - Jest + @testing-library/react-native; one smoke test that renders the home tab without errors
      - ESlint + Prettier with expo preset; lint passes with zero warnings
    checks:
      - file_exists: package.json
      - file_exists: app/(tabs)/index.tsx
      - cmd: npm install --no-audit --no-fund
      - cmd: npx expo export --platform web
      - cmd: npx jest --passWithNoTests --testPathPattern="smoke" --forceExit
    done_when: Project builds for web export, navigation works, DB initialises, smoke test passes

  - id: expenses
    name: Expense recording
    depends_on: [scaffold]
    tasks:
      - Expense model (id, amount, currency, category, note, date, created_at) stored in SQLite
      - Add Expense screen with numeric amount input, category picker, date picker, and optional note
      - Validation: amount > 0, category required; inline error messages
      - Home screen lists today's expenses, sorted newest-first, with total at the top
      - Delete expense with swipe-to-delete (ReAnimated 3 swipeable)
      - Unit tests for the expense repository (insert, list, delete, total by date range)
    checks:
      - cmd: npx jest --testPathPattern="expense" --forceExit
      - cmd: npx expo export --platform web
    done_when: Expenses can be added, listed, and deleted; repository tests all pass

  - id: budgets
    name: Categories and budget limits
    depends_on: [expenses]
    tasks:
      - 12 default categories (Food, Transport, Housing, Health, Entertainment, etc.) with icons and colours
      - Settings screen: set a monthly budget per category (0 = unlimited)
      - Home screen shows a mini progress bar per category showing spent vs. budget
      - Push notification when a category reaches 80% and 100% of its budget (expo-notifications)
      - Unit tests for budget calculation and notification scheduling logic
    checks:
      - cmd: npx jest --forceExit
      - cmd: npx expo export --platform web
    done_when: Budget bars render correctly, notifications fire at the right thresholds, tests pass

  - id: analytics
    name: History and weekly summary
    depends_on: [budgets]
    tasks:
      - History tab: grouped list by week with weekly total; infinite scroll
      - Weekly Summary screen: bar chart of daily spending (victory-native or react-native-gifted-charts)
      - Spending breakdown by category as a donut chart
      - Export to CSV via Expo Sharing; CSV includes all expenses in the selected date range
      - Snapshot tests for the chart components; integration test for CSV export format
    checks:
      - cmd: npx jest --forceExit
      - cmd: npx expo export --platform web
    done_when: History and charts work; CSV export produces a valid file; all tests pass

# Notes for the engine
# - Use expo-sqlite v14+ (async API)
# - Keep the Expo SDK version consistent across all packages; avoid bare React Native APIs
# - Every screen must handle empty state gracefully with a helpful illustration or message
# - All date arithmetic should use date-fns; never use raw Date arithmetic
# - Monetary values: store as integer cents to avoid floating-point errors
---

Build a cross-platform React Native app. The engine must use the Expo managed workflow throughout and ensure the web export (npx expo export --platform web) passes as the CI check.
