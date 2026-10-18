import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { describe, expect, it, vi } from 'vitest';
import { Alert } from './Alert';
import { BuiltByCredit } from './BuiltByCredit';
import { Button } from './Button';
import { Card } from './Card';
import { KpiTile } from './KpiTile';

describe('Button', () => {
  it('renders a button of type "button" by default and fires onClick', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Refresh</Button>);
    const button = screen.getByRole('button', { name: 'Refresh' });
    expect(button).toHaveAttribute('type', 'button');
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('uses the action tokens for the primary variant', () => {
    render(<Button>Save</Button>);
    const button = screen.getByRole('button');
    expect(button.className).toContain('bg-action');
    expect(button.className).toContain('text-on-action');
    expect(button.className).toContain('min-h-tap');
  });

  it('supports other variants, full width and disabled', () => {
    render(
      <Button variant="secondary" fullWidth disabled>
        Cancel
      </Button>,
    );
    const button = screen.getByRole('button');
    expect(button.className).toContain('bg-surface');
    expect(button.className).toContain('w-full');
    expect(button).toBeDisabled();
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<Button>Save</Button>);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('Card', () => {
  it('renders a labelled section when given a title', () => {
    render(
      <Card title="Tonight" aside="Demo data">
        <p>Body</p>
      </Card>,
    );
    const section = screen.getByRole('region', { name: 'Tonight' });
    expect(section).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Tonight' })).toBeInTheDocument();
    expect(screen.getByText('Demo data')).toBeInTheDocument();
  });

  it('renders a plain div without a title', () => {
    const { container } = render(<Card>Body</Card>);
    expect(container.firstElementChild?.tagName).toBe('DIV');
    expect(container.firstElementChild).not.toHaveAttribute('aria-labelledby');
  });

  it('honours the heading level', () => {
    render(
      <Card title="Sub" headingLevel={3}>
        Body
      </Card>,
    );
    expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('Sub');
  });

  it('has no accessibility violations', async () => {
    const { container } = render(
      <main>
        <Card title="Tonight" aside="Demo data">
          <p>Body</p>
        </Card>
      </main>,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('Alert', () => {
  it('uses role="status" for info and warning', () => {
    render(<Alert title="Sync behind">POS data is 20 minutes old.</Alert>);
    const alert = screen.getByRole('status');
    expect(alert).toHaveAccessibleName(/^Note ?: Sync behind$/);
    expect(alert).toHaveAccessibleDescription('POS data is 20 minutes old.');
  });

  it('uses role="alert" for critical and names the severity in words', () => {
    render(
      <Alert severity="critical" title="Counter offline">
        Door counter has not reported since 6 pm.
      </Alert>,
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveAccessibleName(/^Urgent ?: Counter offline$/);
    expect(screen.getByText('Urgent')).toBeInTheDocument();
  });

  it('labels warnings as such and renders an action', () => {
    render(
      <Alert severity="warning" title="Labour high" action={<Button>See roster</Button>}>
        Labour is 3% over budget.
      </Alert>,
    );
    expect(screen.getByText('Warning')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'See roster' })).toBeInTheDocument();
  });

  it('has no accessibility violations in any severity', async () => {
    const { container } = render(
      <div>
        <Alert title="A">a</Alert>
        <Alert severity="warning" title="B">
          b
        </Alert>
        <Alert severity="critical" title="C">
          c
        </Alert>
      </div>,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('KpiTile', () => {
  it('renders label, value and a worded change with a comparison', () => {
    render(
      <KpiTile
        label="Revenue today"
        value="$12,480 ex GST"
        change={{ direction: 'up', amount: '4.2%', comparison: 'vs budget' }}
      />,
    );
    expect(screen.getByRole('article', { name: 'Revenue today' })).toBeInTheDocument();
    expect(screen.getByText('$12,480 ex GST')).toBeInTheDocument();
    expect(screen.getByText('Up 4.2%')).toBeInTheDocument();
    expect(screen.getByText(/vs budget/)).toBeInTheDocument();
    // The icon is decorative; the words carry the meaning.
    const svg = screen.getByRole('article').querySelector('svg');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
  });

  it('says "Down" and "No change"', () => {
    const { rerender } = render(
      <KpiTile
        label="Covers"
        value="312"
        change={{ direction: 'down', amount: '18', comparison: 'vs last Saturday' }}
      />,
    );
    expect(screen.getByText('Down 18')).toBeInTheDocument();
    rerender(
      <KpiTile
        label="Covers"
        value="312"
        change={{ direction: 'flat', amount: '0', comparison: 'vs last Saturday' }}
      />,
    );
    expect(screen.getByText('No change')).toBeInTheDocument();
    expect(screen.queryByText(/No change 0/)).not.toBeInTheDocument();
  });

  it('colours the indicator by sentiment, defaulting from direction', () => {
    const { rerender } = render(
      <KpiTile
        label="Labour"
        value="31.2%"
        change={{ direction: 'up', amount: '1.4 pts', comparison: 'vs budget' }}
      />,
    );
    let indicator = screen.getByRole('article').querySelector('svg')?.parentElement;
    expect(indicator?.className).toContain('text-positive');
    rerender(
      <KpiTile
        label="Labour"
        value="31.2%"
        change={{
          direction: 'up',
          amount: '1.4 pts',
          comparison: 'vs budget',
          sentiment: 'negative',
        }}
      />,
    );
    indicator = screen.getByRole('article').querySelector('svg')?.parentElement;
    expect(indicator?.className).toContain('text-negative');
  });

  it('shows the likely range for forecasts', () => {
    render(
      <KpiTile
        label="Expected revenue tonight"
        value="$9,400 ex GST"
        forecastRange={{ low: '$8,600', high: '$10,300' }}
        footnote="Demo data"
      />,
    );
    expect(screen.getByText(/Likely range/)).toHaveTextContent('Likely range $8,600–$10,300');
    expect(screen.getByText('Demo data')).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const { container } = render(
      <main>
        <h1>Dashboard</h1>
        <h2>Today</h2>
        <KpiTile
          label="Revenue today"
          value="$12,480 ex GST"
          change={{ direction: 'up', amount: '4.2%', comparison: 'vs budget' }}
          forecastRange={{ low: '$11,800', high: '$13,200' }}
          footnote="Demo data"
        />
      </main>,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('BuiltByCredit', () => {
  it('renders the default credit', () => {
    render(<BuiltByCredit />);
    expect(screen.getByText('Built by Foresite')).toBeInTheDocument();
  });

  it('renders the theme credit when given', () => {
    render(<BuiltByCredit credit="Built by Foresite for Acme" />);
    expect(screen.getByText('Built by Foresite for Acme')).toBeInTheDocument();
  });

  it('is small print', () => {
    render(<BuiltByCredit />);
    expect(screen.getByText('Built by Foresite').className).toContain('text-label');
  });
});
