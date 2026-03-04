# Tenafy Rebuild — Style Guide

## Component Library
- **Ant Design 5** (`antd@^5.12.0`) — primary UI framework
- **Ant Design Icons** (`@ant-design/icons@^5.2.6`)
- **No Tailwind** — all styling via Ant Design components + inline styles

## Color Palette

### Brand / System Colors
| Color | Hex | Usage |
|-------|-----|-------|
| Primary Blue | `#1677ff` | Buttons, links, active states |
| Ant Blue | `#1890ff` | Count badges, some highlights |
| Success Green | `#52c41a` | Active lease, paid status, positive indicators |
| Error Red | `#ff4d4f` | Errors, overdue status, delete actions |
| Warning Orange | `#faad14` | Warnings |
| Purple | `#597ef7` | Lease-related icons |

### Layout Colors
| Color | Hex | Usage |
|-------|-----|-------|
| Sidebar Background | `#001529` | Dark navy sidebar |
| Header Background | `#fff` | White header |
| Content Background | `#fff` | White content area |
| Card Border | `#e8e8e8` | Card/container borders |
| Divider | `#f0f0f0` | Row separators, light borders |
| Hover Background | `#fafafa` | Row hover states |
| Muted Text | `#888` | Secondary labels, icon labels |
| Light Blue BG | `#e6f4ff` | Avatar backgrounds |
| Light Green BG | `#f6ffed` | Active status icon backgrounds |
| Light Blue BG | `#f0f5ff` | Lease icon backgrounds |
| Light Gray BG | `#f5f5f5` | Inactive status backgrounds |

### Status Colors
| Status | Border/Icon | Background |
|--------|------------|------------|
| Active/Green | `#52c41a` | `#f6ffed` |
| Inactive/Grey | `#d9d9d9` | `#f5f5f5` |
| Lease/Blue | `#597ef7` | `#f0f5ff` |

## Typography

### Font Family
```css
font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
```

### Font Sizes
| Context | Size |
|---------|------|
| Page titles (h1) | Default Ant Design |
| Card titles | Default Ant Design |
| Body text | `14px` |
| Secondary text | `12px` |
| Icon labels | `10px` (font-weight: 600) |
| Count badges | `18px` (font-weight: 700) |

## Layout

### Main Layout
- **Sidebar**: 200px expanded, 80px collapsed, dark theme
- **Header**: 64px height, white background, sticky
- **Content padding**: 24px
- **Max content width**: 900px for forms, fluid for lists

### Spacing
| Context | Value |
|---------|-------|
| Card/section padding | `14px 20px` (rows), `12px 20px` (toolbars) |
| Row gap | `16px` |
| Button spacing | `6px` (Space size="small") |
| Form gutter | `16px` (Row gutter) |
| Section margin | `16px` bottom |
| Content margin | `24px` |

### Card Styling
```javascript
{
  background: '#fff',
  border: '1px solid #e8e8e8',
  borderRadius: 8,
  padding: '12px 20px'
}
```

## Component Patterns

### Status Icons (Circle Pattern)
Used for tenant status, rent status, lease status on tenant list:
```javascript
{
  width: 36, height: 36, borderRadius: '50%',
  background: isActive ? '#f6ffed' : '#f5f5f5',
  border: `2px solid ${isActive ? '#52c41a' : '#d9d9d9'}`,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
}
// Label below: fontSize 10, fontWeight 600, color '#888'
```

### Tenant Detail — Two-Column Layout
- Left sidebar: 380px fixed width, white background, border-right
- Right content: flex: 1
- Sidebar sections: avatar (80px), name, status dot, financial summary
- Content tabs: underline style with blue indicator

### Field-Value Grid (Profile Display)
```javascript
// 3-column grid for displaying label-value pairs
<div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px 24px' }}>
  <div>
    <div style={{ color: '#888', fontSize: 12, marginBottom: 4 }}>Label</div>
    <div style={{ fontSize: 14, fontWeight: 500 }}>Value</div>
  </div>
</div>
```

### Section Headers
```javascript
<div style={{
  fontSize: 13, fontWeight: 700, color: '#333',
  borderBottom: '2px solid #1890ff',
  paddingBottom: 6, marginBottom: 16
}}>
  SECTION TITLE
</div>
```

### Row Hover Effect
```javascript
onMouseEnter={(e) => e.currentTarget.style.background = '#fafafa'}
onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
```

### Form Layout
- `Form.useForm()` hook
- `layout="vertical"`
- Row/Col grid with `gutter={16}`
- Common column spans: `span={12}` (half), `span={8}` (third)
- Submit button: `type="primary"` with loading state

## CSS Approach
- **Inline styles** on Ant Design components (primary approach)
- **No CSS modules or styled-components**
- **globals.css** contains only resets (box-sizing, margin, padding)
- Theme customization via inline style props, not ConfigProvider
