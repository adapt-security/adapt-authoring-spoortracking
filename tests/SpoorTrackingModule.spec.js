import { describe, it, mock, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import SpoorTrackingModule from '../lib/SpoorTrackingModule.js'

// A valid 24-char hex string so parseObjectId() doesn't throw
const COURSE_ID = '0123456789abcdef01234567'

/**
 * Builds a chainable cursor mock for collection.find(...).sort(...).limit(...).toArray()
 */
function makeCursor (docs) {
  const cursor = {
    sort: mock.fn(() => cursor),
    limit: mock.fn(() => cursor),
    toArray: mock.fn(async () => docs)
  }
  return cursor
}

/**
 * Creates a mock SpoorTrackingModule instance with stubbed content + mongodb collaborators.
 * `config` lets each test seed the counter/content collection responses.
 */
function createMockInstance (config = {}) {
  const {
    counterDoc = null, // result of counters.findOne
    incResult = { seq: 1 }, // result of counters.findOneAndUpdate
    maxBlock = [] // docs returned for the findMaxTrackingId lookup
  } = config

  const countersMock = {
    findOne: mock.fn(async () => counterDoc),
    updateOne: mock.fn(async () => ({})),
    findOneAndUpdate: mock.fn(async () => incResult)
  }
  const contentColMock = {
    find: mock.fn(() => makeCursor(maxBlock)),
    updateOne: mock.fn(async () => ({}))
  }

  const contentMock = {
    collectionName: 'content',
    counterCollectionName: 'contentcounters',
    preInsertHook: { tap: mock.fn() }
  }
  const mongodbMock = {
    getCollection: mock.fn(name => name === 'contentcounters' ? countersMock : contentColMock)
  }

  const instance = Object.create(SpoorTrackingModule.prototype)
  instance.content = contentMock
  instance.mongodb = mongodbMock
  instance.log = mock.fn()
  instance._counters = countersMock
  instance._contentCol = contentColMock
  return instance
}

describe('SpoorTrackingModule', () => {
  describe('insertTrackingId', () => {
    let instance

    beforeEach(() => {
      instance = createMockInstance()
      instance.allocateTrackingIds = mock.fn(async () => [42])
    })

    it('should skip non-block types', async () => {
      const data = { _type: 'component', _courseId: COURSE_ID }
      await instance.insertTrackingId(data)
      assert.equal(instance.allocateTrackingIds.mock.callCount(), 0)
      assert.equal(data._trackingId, undefined)
    })

    it('should skip multilang sync inserts (replicas reuse the source id)', async () => {
      const data = { _type: 'block', _courseId: COURSE_ID, _trackingId: 5 }
      await instance.insertTrackingId(data, { _multilangSync: true })
      assert.equal(instance.allocateTrackingIds.mock.callCount(), 0)
      assert.equal(data._trackingId, 5)
    })

    it('should allocate a tracking id for a block', async () => {
      const data = { _type: 'block', _courseId: COURSE_ID }
      await instance.insertTrackingId(data)
      assert.equal(instance.allocateTrackingIds.mock.callCount(), 1)
      assert.deepEqual(instance.allocateTrackingIds.mock.calls[0].arguments, [COURSE_ID, 1])
      assert.equal(data._trackingId, 42)
    })

    it('should overwrite an incoming id on a non-sync block insert (e.g. a clone payload)', async () => {
      const data = { _type: 'block', _courseId: COURSE_ID, _trackingId: 99 }
      await instance.insertTrackingId(data)
      assert.equal(data._trackingId, 42)
    })
  })

  describe('allocateTrackingIds', () => {
    it('should return an empty array for count < 1', async () => {
      const instance = createMockInstance()
      assert.deepEqual(await instance.allocateTrackingIds(COURSE_ID, 0), [])
      assert.equal(instance._counters.findOneAndUpdate.mock.callCount(), 0)
    })

    it('should seed from the existing max then increment when no counter exists', async () => {
      const instance = createMockInstance({
        counterDoc: null,
        maxBlock: [{ _trackingId: 10 }],
        incResult: { seq: 11 }
      })
      const ids = await instance.allocateTrackingIds(COURSE_ID, 1)
      const seedCall = instance._counters.updateOne.mock.calls[0]
      assert.deepEqual(seedCall.arguments[1], { $setOnInsert: { seq: 10 } })
      assert.deepEqual(seedCall.arguments[2], { upsert: true })
      assert.deepEqual(ids, [11])
    })

    it('should not seed when a counter already exists', async () => {
      const instance = createMockInstance({
        counterDoc: { seq: 5 },
        incResult: { seq: 8 }
      })
      const ids = await instance.allocateTrackingIds(COURSE_ID, 3)
      assert.equal(instance._counters.updateOne.mock.callCount(), 0)
      assert.deepEqual(ids, [6, 7, 8])
    })

    it('should reserve a contiguous range and $inc by count', async () => {
      const instance = createMockInstance({
        counterDoc: { seq: 0 },
        incResult: { seq: 4 }
      })
      const ids = await instance.allocateTrackingIds(COURSE_ID, 4)
      const incCall = instance._counters.findOneAndUpdate.mock.calls[0]
      assert.deepEqual(incCall.arguments[1], { $inc: { seq: 4 } })
      assert.deepEqual(incCall.arguments[2], { returnDocument: 'after' })
      assert.deepEqual(ids, [1, 2, 3, 4])
    })
  })

  describe('findMaxTrackingId', () => {
    it('should return 0 when the course has no blocks', async () => {
      const instance = createMockInstance({ maxBlock: [] })
      assert.equal(await instance.findMaxTrackingId(COURSE_ID), 0)
    })

    it('should return the highest tracking id', async () => {
      const instance = createMockInstance({ maxBlock: [{ _trackingId: 17 }] })
      assert.equal(await instance.findMaxTrackingId(COURSE_ID), 17)
    })
  })

  describe('resetCourseTrackingIds', () => {
    it('should renumber blocks 1..n and realign the counter', async () => {
      const instance = createMockInstance()
      instance._contentCol.find.mock.mockImplementation(() => makeCursor([{ _id: 'b1' }, { _id: 'b2' }, { _id: 'b3' }]))
      await instance.resetCourseTrackingIds(COURSE_ID)

      const updates = instance._contentCol.updateOne.mock.calls
      assert.equal(updates.length, 3)
      assert.deepEqual(updates[0].arguments, [{ _id: 'b1' }, { $set: { _trackingId: 1 } }])
      assert.deepEqual(updates[1].arguments, [{ _id: 'b2' }, { $set: { _trackingId: 2 } }])
      assert.deepEqual(updates[2].arguments, [{ _id: 'b3' }, { $set: { _trackingId: 3 } }])
      const counterUpdate = instance._counters.updateOne.mock.calls[0]
      assert.deepEqual(counterUpdate.arguments[1], { $set: { seq: 3 } })
      assert.equal(instance.log.mock.callCount(), 1)
    })

    it('should do nothing to blocks when none are found', async () => {
      const instance = createMockInstance()
      instance._contentCol.find.mock.mockImplementation(() => makeCursor([]))
      await instance.resetCourseTrackingIds(COURSE_ID)
      assert.equal(instance._contentCol.updateOne.mock.callCount(), 0)
      assert.deepEqual(instance._counters.updateOne.mock.calls[0].arguments[1], { $set: { seq: 0 } })
    })

    it('should propagate errors', async () => {
      const instance = createMockInstance()
      instance._contentCol.find.mock.mockImplementation(() => { throw new Error('db error') })
      await assert.rejects(() => instance.resetCourseTrackingIds(COURSE_ID), { message: 'db error' })
    })
  })

  describe('resetTrackingHandler', () => {
    let instance

    beforeEach(() => {
      instance = createMockInstance()
      instance.resetCourseTrackingIds = mock.fn(async () => {})
    })

    it('should reset using the courseId param and send 204', async () => {
      const req = { params: { _courseId: COURSE_ID } }
      const res = { sendStatus: mock.fn() }
      const next = mock.fn()
      await instance.resetTrackingHandler(req, res, next)
      assert.deepEqual(instance.resetCourseTrackingIds.mock.calls[0].arguments, [COURSE_ID])
      assert.deepEqual(res.sendStatus.mock.calls[0].arguments, [204])
      assert.equal(next.mock.callCount(), 0)
    })

    it('should call next with the error on failure', async () => {
      instance.resetCourseTrackingIds = mock.fn(async () => { throw new Error('fail') })
      const req = { params: { _courseId: COURSE_ID } }
      const res = { sendStatus: mock.fn() }
      const next = mock.fn()
      await instance.resetTrackingHandler(req, res, next)
      assert.equal(next.mock.calls[0].arguments[0].message, 'fail')
      assert.equal(res.sendStatus.mock.callCount(), 0)
    })
  })

  describe('class structure', () => {
    it('should export a class with the expected methods', () => {
      assert.equal(typeof SpoorTrackingModule, 'function')
      ;['init', 'insertTrackingId', 'allocateTrackingIds', 'findMaxTrackingId', 'resetCourseTrackingIds', 'resetTrackingHandler']
        .forEach(m => assert.equal(typeof SpoorTrackingModule.prototype[m], 'function'))
    })
  })
})
