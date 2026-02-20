import { describe, it, mock, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import SpoorTrackingModule from '../lib/SpoorTrackingModule.js'

/**
 * Creates a mock SpoorTrackingModule instance with stubbed app dependencies.
 * Since SpoorTrackingModule extends AbstractModule and relies on a running
 * application, we construct a plain object with the module's prototype methods
 * and inject mock collaborators.
 */
function createMockInstance (overrides = {}) {
  const contentMock = {
    find: mock.fn(async () => []),
    update: mock.fn(async () => ({})),
    preInsertHook: { tap: mock.fn() }
  }
  const authMock = {
    secureRoute: mock.fn()
  }
  const serverMock = {
    api: {
      createChildRouter: mock.fn(() => ({
        addRoute: mock.fn()
      }))
    }
  }
  const appMock = {
    waitForModule: mock.fn(async (...names) => {
      const map = { auth: authMock, content: contentMock, server: serverMock }
      if (names.length === 1) return map[names[0]]
      return names.map(n => map[n])
    })
  }
  const logMock = mock.fn()

  const instance = Object.create(SpoorTrackingModule.prototype)
  instance.app = appMock
  instance.log = logMock
  instance._contentMock = contentMock
  instance._authMock = authMock
  instance._serverMock = serverMock
  instance._appMock = appMock

  Object.assign(instance, overrides)
  return instance
}

describe('SpoorTrackingModule', () => {
  describe('insertTrackingId', () => {
    let instance

    beforeEach(() => {
      instance = createMockInstance()
    })

    it('should skip non-block types', async () => {
      const data = { _type: 'component', _courseId: 'course1' }
      await instance.insertTrackingId(data)
      assert.equal(instance._contentMock.find.mock.callCount(), 0)
      assert.equal(data._trackingId, undefined)
    })

    it('should skip if _trackingId is already an integer', async () => {
      const data = { _type: 'block', _courseId: 'course1', _trackingId: 5 }
      await instance.insertTrackingId(data)
      assert.equal(instance._contentMock.find.mock.callCount(), 0)
      assert.equal(data._trackingId, 5)
    })

    it('should skip if _trackingId is 0 (a valid integer)', async () => {
      const data = { _type: 'block', _courseId: 'course1', _trackingId: 0 }
      await instance.insertTrackingId(data)
      assert.equal(instance._contentMock.find.mock.callCount(), 0)
      assert.equal(data._trackingId, 0)
    })

    it('should assign _trackingId as max + 1 when blocks exist', async () => {
      instance._contentMock.find.mock.mockImplementation(async () => [{ _trackingId: 10 }])
      const data = { _type: 'block', _courseId: 'course1' }
      await instance.insertTrackingId(data)
      assert.equal(data._trackingId, 11)
    })

    it('should assign _trackingId 1 when existing block has _trackingId 0', async () => {
      instance._contentMock.find.mock.mockImplementation(async () => [{ _trackingId: 0 }])
      const data = { _type: 'block', _courseId: 'course1' }
      await instance.insertTrackingId(data)
      assert.equal(data._trackingId, 1)
    })

    it('should call content.find with correct query and options', async () => {
      instance._contentMock.find.mock.mockImplementation(async () => [{ _trackingId: 3 }])
      const data = { _type: 'block', _courseId: 'courseABC' }
      await instance.insertTrackingId(data)
      const call = instance._contentMock.find.mock.calls[0]
      assert.deepEqual(call.arguments[0], { _courseId: 'courseABC' })
      assert.deepEqual(call.arguments[1], {})
      assert.deepEqual(call.arguments[2], { limit: 1, sort: [['_trackingId', -1]] })
    })

    it('should not skip when _trackingId is a non-integer number', async () => {
      instance._contentMock.find.mock.mockImplementation(async () => [{ _trackingId: 5 }])
      const data = { _type: 'block', _courseId: 'course1', _trackingId: 1.5 }
      await instance.insertTrackingId(data)
      assert.equal(data._trackingId, 6)
    })

    it('should not skip when _trackingId is a string', async () => {
      instance._contentMock.find.mock.mockImplementation(async () => [{ _trackingId: 2 }])
      const data = { _type: 'block', _courseId: 'course1', _trackingId: '5' }
      await instance.insertTrackingId(data)
      assert.equal(data._trackingId, 3)
    })

    it('should use nullish coalescing so undefined _trackingId defaults to 1', async () => {
      instance._contentMock.find.mock.mockImplementation(async () => [{ _trackingId: undefined }])
      const data = { _type: 'block', _courseId: 'course1' }
      await instance.insertTrackingId(data)
      assert.equal(data._trackingId, 1)
    })

    it('should handle null _trackingId in result using nullish coalescing', async () => {
      instance._contentMock.find.mock.mockImplementation(async () => [{ _trackingId: null }])
      const data = { _type: 'block', _courseId: 'course1' }
      await instance.insertTrackingId(data)
      assert.equal(data._trackingId, 1)
    })

    it('should handle empty find result gracefully', async () => {
      instance._contentMock.find.mock.mockImplementation(async () => [])
      const data = { _type: 'block', _courseId: 'emptyCourse' }
      await instance.insertTrackingId(data)
      assert.equal(data._trackingId, 1)
    })
  })

  describe('resetCourseTrackingIds', () => {
    let instance

    beforeEach(() => {
      instance = createMockInstance()
    })

    it('should reassign sequential _trackingId values starting from 1', async () => {
      const blocks = [
        { _id: 'b1', _trackingId: 5 },
        { _id: 'b2', _trackingId: 12 },
        { _id: 'b3', _trackingId: 20 }
      ]
      instance._contentMock.find.mock.mockImplementation(async () => blocks)
      await instance.resetCourseTrackingIds('course1')

      const updateCalls = instance._contentMock.update.mock.calls
      assert.equal(updateCalls.length, 3)
      assert.deepEqual(updateCalls[0].arguments, [{ _id: 'b1' }, { _trackingId: 1 }, { schemaName: 'block' }])
      assert.deepEqual(updateCalls[1].arguments, [{ _id: 'b2' }, { _trackingId: 2 }, { schemaName: 'block' }])
      assert.deepEqual(updateCalls[2].arguments, [{ _id: 'b3' }, { _trackingId: 3 }, { schemaName: 'block' }])
    })

    it('should query for blocks sorted by _trackingId ascending', async () => {
      instance._contentMock.find.mock.mockImplementation(async () => [])
      await instance.resetCourseTrackingIds('courseXYZ')

      const call = instance._contentMock.find.mock.calls[0]
      assert.deepEqual(call.arguments[0], { _type: 'block', _courseId: 'courseXYZ' })
      assert.deepEqual(call.arguments[1], {})
      assert.deepEqual(call.arguments[2], { sort: [['_trackingId', 1]] })
    })

    it('should do nothing when no blocks are found', async () => {
      instance._contentMock.find.mock.mockImplementation(async () => [])
      await instance.resetCourseTrackingIds('emptyCourse')
      assert.equal(instance._contentMock.update.mock.callCount(), 0)
    })

    it('should log a debug message after resetting', async () => {
      instance._contentMock.find.mock.mockImplementation(async () => [])
      await instance.resetCourseTrackingIds('course1')
      assert.equal(instance.log.mock.callCount(), 1)
      assert.deepEqual(instance.log.mock.calls[0].arguments, ['debug', 'RESET', 'course1'])
    })

    it('should handle a single block', async () => {
      const blocks = [{ _id: 'b1', _trackingId: 99 }]
      instance._contentMock.find.mock.mockImplementation(async () => blocks)
      await instance.resetCourseTrackingIds('course1')

      const updateCalls = instance._contentMock.update.mock.calls
      assert.equal(updateCalls.length, 1)
      assert.deepEqual(updateCalls[0].arguments, [{ _id: 'b1' }, { _trackingId: 1 }, { schemaName: 'block' }])
    })

    it('should propagate errors from content.find', async () => {
      instance._contentMock.find.mock.mockImplementation(async () => { throw new Error('db error') })
      await assert.rejects(
        () => instance.resetCourseTrackingIds('course1'),
        { message: 'db error' }
      )
    })

    it('should propagate errors from content.update', async () => {
      instance._contentMock.find.mock.mockImplementation(async () => [{ _id: 'b1', _trackingId: 1 }])
      instance._contentMock.update.mock.mockImplementation(async () => { throw new Error('update failed') })
      await assert.rejects(
        () => instance.resetCourseTrackingIds('course1'),
        { message: 'update failed' }
      )
    })
  })

  describe('resetTrackingHandler', () => {
    let instance

    beforeEach(() => {
      instance = createMockInstance()
    })

    it('should call resetCourseTrackingIds with the courseId from params', async () => {
      instance._contentMock.find.mock.mockImplementation(async () => [])
      const req = { params: { _courseId: 'course123' } }
      const res = { sendStatus: mock.fn() }
      const next = mock.fn()

      await instance.resetTrackingHandler(req, res, next)

      const findCall = instance._contentMock.find.mock.calls[0]
      assert.deepEqual(findCall.arguments[0], { _type: 'block', _courseId: 'course123' })
    })

    it('should send 204 on success', async () => {
      instance._contentMock.find.mock.mockImplementation(async () => [])
      const req = { params: { _courseId: 'course1' } }
      const res = { sendStatus: mock.fn() }
      const next = mock.fn()

      await instance.resetTrackingHandler(req, res, next)

      assert.equal(res.sendStatus.mock.callCount(), 1)
      assert.deepEqual(res.sendStatus.mock.calls[0].arguments, [204])
      assert.equal(next.mock.callCount(), 0)
    })

    it('should call next with error on failure', async () => {
      instance._contentMock.find.mock.mockImplementation(async () => { throw new Error('fail') })
      const req = { params: { _courseId: 'course1' } }
      const res = { sendStatus: mock.fn() }
      const next = mock.fn()

      await instance.resetTrackingHandler(req, res, next)

      assert.equal(next.mock.callCount(), 1)
      assert.equal(next.mock.calls[0].arguments[0].message, 'fail')
      assert.equal(res.sendStatus.mock.callCount(), 0)
    })
  })

  describe('class structure', () => {
    it('should export a class', () => {
      assert.equal(typeof SpoorTrackingModule, 'function')
      assert.equal(typeof SpoorTrackingModule.prototype.init, 'function')
      assert.equal(typeof SpoorTrackingModule.prototype.insertTrackingId, 'function')
      assert.equal(typeof SpoorTrackingModule.prototype.resetCourseTrackingIds, 'function')
      assert.equal(typeof SpoorTrackingModule.prototype.resetTrackingHandler, 'function')
    })
  })
})
