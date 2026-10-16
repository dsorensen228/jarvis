from __future__ import annotations

import logging
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger(__name__)

COCO_LABELS = (
    "person",
    "bicycle",
    "car",
    "motorcycle",
    "airplane",
    "bus",
    "train",
    "truck",
    "boat",
    "traffic light",
    "fire hydrant",
    "stop sign",
    "parking meter",
    "bench",
    "bird",
    "cat",
    "dog",
    "horse",
    "sheep",
    "cow",
    "elephant",
    "bear",
    "zebra",
    "giraffe",
    "backpack",
    "umbrella",
    "handbag",
    "tie",
    "suitcase",
    "frisbee",
    "skis",
    "snowboard",
    "sports ball",
    "kite",
    "baseball bat",
    "baseball glove",
    "skateboard",
    "surfboard",
    "tennis racket",
    "bottle",
    "wine glass",
    "cup",
    "fork",
    "knife",
    "spoon",
    "bowl",
    "banana",
    "apple",
    "sandwich",
    "orange",
    "broccoli",
    "carrot",
    "hot dog",
    "pizza",
    "donut",
    "cake",
    "chair",
    "couch",
    "potted plant",
    "bed",
    "dining table",
    "toilet",
    "tv",
    "laptop",
    "mouse",
    "remote",
    "keyboard",
    "cell phone",
    "microwave",
    "oven",
    "toaster",
    "sink",
    "refrigerator",
    "book",
    "clock",
    "vase",
    "scissors",
    "teddy bear",
    "hair drier",
    "toothbrush",
)


@dataclass(frozen=True)
class Detection:
    category: int
    confidence: float


def label_for_category(category: int, labels: Sequence[str] = COCO_LABELS) -> str:
    return labels[category].strip().lower() if 0 <= category < len(labels) else ""


def highest_person_score(
    detections: Iterable[Any], threshold: float, labels: Sequence[str] = COCO_LABELS
) -> float:
    scores = []
    for detection in detections:
        try:
            category = int(getattr(detection, "category"))
            confidence = float(getattr(detection, "confidence", getattr(detection, "conf", None)))
        except (AttributeError, TypeError, ValueError):
            continue
        if confidence >= threshold and label_for_category(category, labels) == "person":
            scores.append(confidence)
    return max(scores, default=0.0)


@dataclass
class PresenceGate:
    clear_seconds: float
    cooldown_seconds: float
    confirmations_required: int = 2
    present: bool = False
    absent_since: float | None = None
    next_event_at: float = 0.0
    consecutive_detections: int = 0

    def update(self, detected: bool, now: float) -> bool:
        if detected:
            self.absent_since = None
            if not self.present:
                self.consecutive_detections += 1
                if self.consecutive_detections < self.confirmations_required:
                    return False
                self.consecutive_detections = 0
                self.present = True
                if now >= self.next_event_at:
                    self.next_event_at = now + self.cooldown_seconds
                    return True
            return False
        self.consecutive_detections = 0
        if not self.present:
            return False
        if self.absent_since is None:
            self.absent_since = now
        if now - self.absent_since >= self.clear_seconds:
            self.present = False
            self.absent_since = None
        return False


class Imx500PersonDetector:
    """Thin IMX500 metadata adapter; imported only on camera hardware."""

    def __init__(
        self,
        model_path: str,
        threshold: float,
        max_detections: int = 10,
        iou: float = 0.65,
    ) -> None:
        from picamera2.devices import IMX500
        from picamera2.devices.imx500 import NetworkIntrinsics

        self.threshold = threshold
        self.max_detections = max_detections
        self.iou = iou
        self.imx500 = IMX500(model_path)
        intrinsics = self.imx500.network_intrinsics or NetworkIntrinsics()
        intrinsics.task = intrinsics.task or "object detection"
        if intrinsics.task != "object detection":
            raise RuntimeError(f"IMX500 model task is {intrinsics.task!r}, not object detection")
        if not intrinsics.labels:
            intrinsics.labels = list(COCO_LABELS)
        intrinsics.update_with_defaults()
        self.intrinsics = intrinsics
        raw_labels = list(intrinsics.labels or COCO_LABELS)
        if getattr(intrinsics, "ignore_dash_labels", False):
            raw_labels = [label for label in raw_labels if label and label != "-"]
        self.labels = tuple(str(label or "").strip().lower() for label in raw_labels)

    @property
    def camera_num(self) -> int:
        return int(self.imx500.camera_num)

    @property
    def inference_rate(self) -> float | None:
        rate = getattr(self.intrinsics, "inference_rate", None)
        try:
            return float(rate) if rate is not None else None
        except (TypeError, ValueError):
            return None

    def initialize(self) -> None:
        self.imx500.show_network_fw_progress_bar()
        if getattr(self.intrinsics, "preserve_aspect_ratio", False):
            self.imx500.set_auto_aspect_ratio()
        logger.info(
            "IMX500 detector ready (postprocess=%s inference_rate=%s labels=%d)",
            getattr(self.intrinsics, "postprocess", None) or "ssd",
            self.inference_rate,
            len(self.labels),
        )

    def detections_from_metadata(self, metadata: dict[str, Any]) -> list[Detection]:
        outputs = self.imx500.get_outputs(metadata, add_batch=True)
        if outputs is None:
            return []

        if getattr(self.intrinsics, "postprocess", None) == "nanodet":
            from picamera2.devices.imx500 import postprocess_nanodet_detection

            processed = postprocess_nanodet_detection(
                outputs=outputs[0],
                conf=self.threshold,
                iou_thres=self.iou,
                max_out_dets=self.max_detections,
            )
            if not processed:
                return []
            _boxes, scores, categories = processed[0]
        else:
            if len(outputs) < 3:
                raise RuntimeError(
                    f"IMX500 object detector returned {len(outputs)} outputs; expected at least 3"
                )
            scores = outputs[1][0]
            categories = outputs[2][0]

        detections = []
        for score, category in zip(scores, categories):
            try:
                detections.append(Detection(int(category), float(score)))
            except (TypeError, ValueError):
                continue
        return detections

    def score(self, metadata: dict[str, Any]) -> float:
        return highest_person_score(
            self.detections_from_metadata(metadata), self.threshold, self.labels
        )
