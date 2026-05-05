import { useState, useEffect } from 'react';
import { Smartphone } from 'lucide-react';
import type { CloneProjectRequestPayload } from '@/types';

interface CloneDialogProps {
  isOpen: boolean;
  initialName: string;
  initialDescription: string;
  /** Device profile the source project was designed for (e.g. "boox-tab-mini-c"). */
  sourceDeviceProfile?: string;
  error: string | null;
  isSubmitting: boolean;
  onConfirm: (payload: CloneProjectRequestPayload) => Promise<void>;
  onClose: () => void;
}

const CloneDialog = ({
  isOpen,
  initialName,
  initialDescription,
  sourceDeviceProfile,
  error,
  isSubmitting,
  onConfirm,
  onClose,
}: CloneDialogProps) => {
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);

  useEffect(() => {
    if (isOpen) {
      setName(initialName);
      setDescription(initialDescription);
    }
  }, [isOpen, initialName, initialDescription]);

  if (!isOpen) {
    return null;
  }

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    await onConfirm({ new_name: name.trim(), new_description: description.trim() || undefined });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-md space-y-4 rounded-lg border border-eink-pale-gray bg-white p-6 shadow-lg"
      >
        <div>
          <h2 className="text-lg font-semibold text-eink-black">Clone this project</h2>
          <p className="mt-1 text-sm text-eink-dark-gray">
            Give your copy a memorable name. You can adjust sharing settings later from the project page.
          </p>
        </div>

        {sourceDeviceProfile && (
          <div className="flex items-start gap-2 rounded-md bg-blue-50 border border-blue-200 px-3 py-2 text-sm">
            <Smartphone size={16} className="text-blue-700 mt-0.5 shrink-0" />
            <div className="text-blue-900">
              Designed for <code className="font-mono bg-blue-100 px-1 rounded">{sourceDeviceProfile}</code>.
              {' '}
              <span className="text-blue-800">
                If your device differs, change the device profile in the cloned project's settings and confirm the rescale prompt — widgets will be repositioned proportionally.
              </span>
            </div>
          </div>
        )}

        <div className="space-y-1">
          <label htmlFor="clone-name" className="block text-sm font-medium text-eink-black">
            Project name
          </label>
          <input
            id="clone-name"
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            minLength={1}
            maxLength={100}
            className="w-full rounded-md border border-eink-pale-gray px-3 py-2 text-sm focus:border-eink-black focus:outline-none focus:ring-0"
          />
        </div>

        <div className="space-y-1">
          <label htmlFor="clone-description" className="block text-sm font-medium text-eink-black">
            Description (optional)
          </label>
          <textarea
            id="clone-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={3}
            maxLength={500}
            className="w-full rounded-md border border-eink-pale-gray px-3 py-2 text-sm focus:border-eink-black focus:outline-none focus:ring-0"
          />
        </div>

        {error ? <div className="text-sm text-red-600">{error}</div> : null}

        <div className="flex items-center justify-end space-x-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-eink-pale-gray px-4 py-2 text-sm text-eink-dark-gray hover:border-eink-black hover:text-eink-black"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={isSubmitting || name.trim().length === 0}
            className="rounded-md bg-eink-black px-4 py-2 text-sm font-semibold text-eink-white transition-opacity disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isSubmitting ? 'Cloning…' : 'Clone project'}
          </button>
        </div>
      </form>
    </div>
  );
};

export default CloneDialog;
