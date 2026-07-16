'use client';

import { Checkbox, Form } from 'antd';

// Reusable "Select all" toggle for a group of boolean Form.Item checkboxes.
// Pass the form instance and the list of field names it controls. It reflects
// checked / indeterminate / unchecked from the watched fields and flips them all
// at once via setFieldsValue. Intended to sit in a Card's `extra` slot.
export default function SelectAllCheckbox({ form, fields, label = 'Select all' }) {
  const names = fields || [];
  // useWatch with a selector re-renders when any watched field changes.
  const values =
    Form.useWatch((all) => names.map((f) => !!(all && all[f])), form) || [];
  const checkedCount = values.filter(Boolean).length;
  const total = names.length;
  const allChecked = total > 0 && checkedCount === total;
  const indeterminate = checkedCount > 0 && checkedCount < total;

  const onChange = (e) => {
    const next = {};
    names.forEach((f) => {
      next[f] = e.target.checked;
    });
    form.setFieldsValue(next);
  };

  return (
    <Checkbox
      checked={allChecked}
      indeterminate={indeterminate}
      onChange={onChange}
      style={{ fontWeight: 400, fontSize: 13 }}
    >
      {label}
    </Checkbox>
  );
}
