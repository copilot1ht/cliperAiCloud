class BodyTracker:
    def __init__(self):
        self.available = False
        self.detector = None
        try:
            import cv2
            haar_dir = getattr(getattr(cv2, "data", None), "haarcascades", "")
            detector = cv2.CascadeClassifier(f"{haar_dir}haarcascade_upperbody.xml")
            if not detector.empty():
                self.available = True
                self.detector = detector
        except Exception:
            self.available = False
            self.detector = None

    def track(self, frame):
        if not self.available or frame is None:
            return []
        try:
            import cv2
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            bodies = self.detector.detectMultiScale(gray, scaleFactor=1.08, minNeighbors=3, minSize=(60, 80))
            return [{"x": int(x), "y": int(y), "w": int(w), "h": int(h)} for (x, y, w, h) in bodies]
        except Exception:
            return []
