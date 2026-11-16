import type * as React from 'react';
export type StageId = 'find' | 'research' | 'bid' | 'award' | 'subs' | 'schedule' | 'bill' | 'pay' | 'closeout';
export type Template = 'blueprint' | 'hivis' | 'field';
export type Tone = 'neutral' | 'success' | 'info' | 'warning' | 'danger';
export interface Stage { id: string; label: string; phase?: string; blurb?: string }
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> { variant?: 'primary' | 'secondary' | 'accent' | 'ghost'; size?: 'sm' | 'md' | 'lg'; /** Written as data-track and reported as a click event. */ trackId?: string }
export declare function Button(props: ButtonProps): React.ReactElement;
export interface SignupFormProps { cta?: string; note?: string; label?: string; layout?: 'inline' | 'stacked'; onShell?: boolean; ctaVariant?: 'primary' | 'accent'; trackId?: string; onSubmit?: (email: string) => void }
export declare function SignupForm(props: SignupFormProps): React.ReactElement;
export interface StatusPillProps { tone?: Tone; children?: React.ReactNode }
export declare function StatusPill(props: StatusPillProps): React.ReactElement;
export interface StageBadgeProps { stage: StageId; stages?: Stage[] }
export declare function StageBadge(props: StageBadgeProps): React.ReactElement | null;
export interface LifecycleStepperProps { current: StageId; compact?: boolean; onShell?: boolean; label?: string; stages?: Stage[] }
export declare function LifecycleStepper(props: LifecycleStepperProps): React.ReactElement;
export interface KpiTileProps { label: string; value: string; id?: string; delta?: string; deltaTone?: Tone; hint?: string; tone?: 'success' | 'danger'; onShell?: boolean }
export declare function KpiTile(props: KpiTileProps): React.ReactElement;
export interface MoneySummaryProps { revenue: number; expense: number; period?: string; plain?: boolean; onShell?: boolean }
export declare function MoneySummary(props: MoneySummaryProps): React.ReactElement;
export interface ProfitChartProps { data: { label: string; revenue: number; expense: number }[]; height?: number }
export declare function ProfitChart(props: ProfitChartProps): React.ReactElement;
export interface OpportunityCardProps { title: string; owner: string; value: number; stage?: StageId; due?: string; match?: number; flag?: string; flagTone?: Tone; action?: string; actionVariant?: 'primary' | 'secondary'; trackId?: string; onAction?: () => void }
export declare function OpportunityCard(props: OpportunityCardProps): React.ReactElement;
export interface PayablesTableProps { rows: { payee: string; role: string; project: string; due: string; amount: number; status: 'Paid' | 'Approved' | 'Awaiting approval' | 'Overdue' }[] }
export declare function PayablesTable(props: PayablesTableProps): React.ReactElement;
export interface DataTableColumn<Row = any> { key: string; label: string; align?: 'left' | 'right'; num?: boolean; render?: (row: Row) => React.ReactNode }
export interface DataTableProps<Row = any> { columns: DataTableColumn<Row>[]; rows: Row[]; caption?: string; empty?: React.ReactNode }
export declare function DataTable(props: DataTableProps): React.ReactElement;
export interface ProgressBarProps { value: number; max: number; label?: string }
export declare function ProgressBar(props: ProgressBarProps): React.ReactElement;
export interface ChecklistItem { label: string; detail?: string; state: 'done' | 'open' | 'blocked'; action?: string; onAction?: () => void; trackId?: string }
export interface ChecklistProps { items: ChecklistItem[] }
export declare function Checklist(props: ChecklistProps): React.ReactElement;
export interface ScheduleBoardProps { days: { dow: string; date: string; off?: boolean }[]; rows: { label: string; items: { start: number; span?: number; label: string; tone?: 'work' | 'milestone' | 'due' }[] }[]; today?: number; label?: string }
export declare function ScheduleBoard(props: ScheduleBoardProps): React.ReactElement;
export type WorkspaceView = 'overview' | 'find_work' | 'bids' | 'projects' | 'subs_vendors' | 'schedule' | 'money' | 'closeout' | 'bid_detail' | 'award' | 'project_detail' | 'pay_app' | 'settings' | 'welcome' | 'import_bid' | 'sub_detail' | 'pay_run' | 'change_order';
export type SitePage = 'home' | 'pricing' | 'signin' | 'signup' | 'onboarding' | 'app' | 'reset' | 'reset_sent' | 'new_password' | 'terms' | 'privacy' | 'not_found' | 'error' | 'trial_ended';
export interface TextFieldProps { label: string; type?: string; name?: string; value?: string; defaultValue?: string; placeholder?: string; hint?: string; autoComplete?: string; required?: boolean; optional?: boolean; multiline?: boolean; error?: string; onChange?: (value: string) => void }
export declare function TextField(props: TextFieldProps): React.ReactElement;
export interface ChipSelectProps { label: string; options: string[]; value?: string[]; defaultValue?: string[]; multiple?: boolean; hint?: string; onChange?: (selected: string[]) => void }
export declare function ChipSelect(props: ChipSelectProps): React.ReactElement;
export interface PricingPageProps { template?: Template; onNavigate?: (page: SitePage) => void }
export declare function PricingPage(props: PricingPageProps): React.ReactElement;
export interface AuthPageProps { template?: Template; mode?: 'signup' | 'signin' | 'reset' | 'new_password'; email?: string; error?: string; fieldError?: string; onNavigate?: (page: SitePage) => void }
export declare function AuthPage(props: AuthPageProps): React.ReactElement;
export interface OnboardingProps { template?: Template; step?: number; onDone?: (start: 'import' | 'match' | 'sample') => void; onNavigate?: (page: SitePage) => void }
export declare function Onboarding(props: OnboardingProps): React.ReactElement;
export interface PrototypeProps { template?: Template; start?: SitePage; view?: WorkspaceView; onNavigate?: (page: SitePage) => void }
export declare function Prototype(props: PrototypeProps): React.ReactElement;
export interface NoticeProps { tone?: 'info' | 'success' | 'warning' | 'danger'; title?: string; children?: React.ReactNode; action?: string; onAction?: () => void; trackId?: string }
export declare function Notice(props: NoticeProps): React.ReactElement;
export interface EmptyStateProps { title: string; children?: React.ReactNode; id?: string; action?: string; onAction?: () => void; trackId?: string; secondary?: string; onSecondary?: () => void; secondaryTrackId?: string }
export declare function EmptyState(props: EmptyStateProps): React.ReactElement;
export interface DialogProps { open?: boolean; title: string; children?: React.ReactNode; confirm?: string; cancel?: string; onConfirm?: () => void; onCancel?: () => void; trackId?: string }
export declare function Dialog(props: DialogProps): React.ReactElement | null;
export interface SkeletonProps { lines?: number; label?: string }
export declare function Skeleton(props: SkeletonProps): React.ReactElement;
export interface MessagePageProps { template?: Template; kind?: 'trial_ended' | 'not_found' | 'error' | 'reset_sent'; onNavigate?: (page: SitePage) => void }
export declare function MessagePage(props: MessagePageProps): React.ReactElement;
export interface ArticlePageProps { template?: Template; kind?: 'terms' | 'privacy'; onNavigate?: (page: SitePage) => void }
export declare function ArticlePage(props: ArticlePageProps): React.ReactElement;
export interface Award { id: string; contractor: string; amount: number; /** YYYY-MM */ start: string; /** YYYY-MM */ end: string; contract?: string; agency?: string; scope?: string; offers?: string; changes?: string }
export interface AwardHistoryProps { awards?: Award[]; title?: string; source?: string }
export declare function AwardHistory(props: AwardHistoryProps): React.ReactElement | null;
export interface ExperimentProps { name: string; variants: Record<string, React.ReactNode | ((key: string) => React.ReactNode)>; userId?: string; weights?: number[]; force?: string }
export declare function Experiment(props: ExperimentProps): React.ReactElement | null;
export interface LandingPageProps { template?: Template; /** Blueprint and Hi-Vis. */ onNavigate?: (page: SitePage, email?: string) => void }
export declare function LandingPage(props: LandingPageProps): React.ReactElement;
export interface WorkspaceProps { template?: Template; /** Blueprint and Hi-Vis: the opening screen. */ view?: WorkspaceView; /** Blueprint and Hi-Vis. */ onNavigate?: (view: WorkspaceView) => void; onPlans?: () => void; onSignOut?: () => void }
export declare function Workspace(props: WorkspaceProps): React.ReactElement;
export interface TrackPayload { event: string; props: Record<string, unknown>; at: number }
export declare function assignVariant(userId: string, experiment: string, variants: string[], weights?: number[]): string | null;
export declare function hashString(s: string): number;
export declare function track(event: string, props?: Record<string, unknown>): TrackPayload;
export declare function setTracker(fn: ((payload: TrackPayload) => void) | null): void;
export declare function formatMoney(n: number, opts?: { cents?: boolean; compact?: boolean }): string;
export declare function formatPercent(fraction: number | null): string;
export declare function profitMargin(revenue: number, expense: number): number | null;
export declare function stageIndex(id: string, stages?: Stage[]): number;
export declare const STAGES: Stage[];
export declare const TEMPLATES: Template[];
export declare function checklistProgress(items?: { state?: string }[]): { done: number; total: number };
export declare function navId(label: string): string;
export declare const VIEWS: WorkspaceView[];
export declare function viewParent(view: string): string;
export declare function jobTotals(jobs?: { contract?: number; billed?: number; cost?: number }[]): { count: number; contract: number; billed: number; cost: number; margin: number | null };
export declare function filterByStatus<T extends { status?: string }>(rows: T[] | null | undefined, status?: string): T[];
export declare function toggleChoice(selected: string[] | undefined, option: string, multiple?: boolean): string[];
export declare function nextStep(step: number, delta: number, count: number): number;
export declare const PAGES: SitePage[];
export declare function parseMoney(input: string | number | null | undefined): number | null;
export declare function payRunTotal(rows?: { payee: string; amount: number; status: string }[], selected?: string[]): { count: number; amount: number };
export declare function setLinks(next: { page?: (page: SitePage) => string; view?: (view: WorkspaceView) => string }): void;
export declare function modifiedClick(e?: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; button?: number }): boolean;
export declare function viewForStage(stage: string): WorkspaceView;
export declare function parseYearMonth(s: unknown): { year: number; month: number } | null;
export declare function formatYearMonth(s: unknown): string;
export declare function monthsBetween(start: unknown, end: unknown): number | null;
export declare function currentJobs<T extends { stage?: string }>(projects?: T[]): T[];
export declare function jobStats(data?: { quotes?: { status?: string }[]; bids?: { status?: string; amount?: number }[]; jobs?: unknown[]; tasks?: { urgent?: boolean; tone?: string }[] }): { quotesRequested: number; quotesReceived: number; quotesOutstanding: number; bidsAwaiting: number; bidsAwaitingUsd: number; awardedJobs: number; urgent: number };
