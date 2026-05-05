/**
 * Checkbox widget rendering component.
 *
 * Handles checkbox widget rendering on the canvas.
 * Follows CLAUDE.md coding standards - no dummy implementations.
 */

import React from 'react';
import { Widget } from '@/types';
import { getFontCSS } from '@/lib/fonts';
import { mapJustify } from './utils';
import { useEditorStore } from '@/stores/editorStore';
import { replaceTokensForPreview } from '@/lib/tokens';

interface CheckboxWidgetProps {
  widget: Widget;
}

const CheckboxWidget: React.FC<CheckboxWidgetProps> = ({ widget }) => {
  const checkboxSize = widget.properties?.box_size
    ?? widget.properties?.checkbox_size
    ?? 12;

  const fontCSS = getFontCSS(widget.styling?.font);
  const orientation = widget.properties?.orientation || 'horizontal';
  const textAlign = widget.styling?.text_align || 'left';
  const samplePreview = useEditorStore((s) => s.samplePreview);
  const rawLabel = widget.content || 'Checkbox';
  const displayLabel = samplePreview ? replaceTokensForPreview(rawLabel) : rawLabel;

  // Determine rotation based on orientation
  const getRotationStyle = () => {
    if (orientation === 'vertical_cw') {
      return { transform: 'rotate(90deg)' };
    } else if (orientation === 'vertical_ccw') {
      return { transform: 'rotate(-90deg)' };
    }
    return {};
  };

  return (
    <div
      className="h-full w-full flex items-center"
      style={{
        justifyContent: mapJustify(textAlign),
        ...getRotationStyle()
      }}
    >
      <div className="flex items-center space-x-2">
        <div
          className="border border-eink-black flex-shrink-0"
          style={{
            width: checkboxSize,
            height: checkboxSize
          }}
        />
        <span
          style={{
            fontSize: (widget.styling?.size || 10),
            fontFamily: fontCSS.fontFamily,
            fontWeight: fontCSS.fontWeight,
            fontStyle: fontCSS.fontStyle,
            color: widget.styling?.color || '#000000'
          }}
        >
          {displayLabel}
        </span>
      </div>
    </div>
  );
};

export default CheckboxWidget;
