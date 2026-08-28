import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getRegisterAgentConfirmButtonLabel,
  getRegisterAgentReviewStepButtonLabel,
  getRegisterAgentReviewTitle,
} from './register-agent-review';

test('register review labels vary by dialog mode', () => {
  assert.equal(
    getRegisterAgentReviewStepButtonLabel({ isUpdateMode: false, isReRegisterMode: false }),
    'Review',
  );
  assert.equal(
    getRegisterAgentReviewTitle({ isUpdateMode: true, isReRegisterMode: false }),
    'Review update',
  );
  assert.equal(
    getRegisterAgentConfirmButtonLabel({
      isSubmitting: false,
      isUpdateMode: false,
      isReRegisterMode: true,
    }),
    'Confirm re-registration',
  );
  assert.equal(
    getRegisterAgentConfirmButtonLabel({
      isSubmitting: true,
      isUpdateMode: true,
      isReRegisterMode: false,
    }),
    'Updating...',
  );
});
